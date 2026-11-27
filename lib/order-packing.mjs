import { createHash } from 'node:crypto';
import { transaction } from './database.mjs';

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
const error = (message, status = 400) => Object.assign(new Error(message), { status });

function destination(source) {
  const raw = source ? JSON.parse(source) : {};
  const shipping = raw?.content?.productOrder?.shippingAddress ?? raw?.productOrder?.shippingAddress ?? raw?.shippingAddress;
  if (!shipping) return { recipient: '', destinationHash: null };
  const recipient = compact(shipping.name), base = compact(shipping.baseAddress), detail = compact(shipping.detailedAddress);
  const parts = [recipient, base, detail, ...['zipCode', 'country', 'state', 'city'].map(field => compact(shipping[field]))];
  const ready = recipient && base && typeof shipping.detailedAddress === 'string' && !parts.some(part => /[*＊●•]/u.test(part));
  return { recipient, destinationHash: ready ? digest(parts) : null };
}

function readPacking(db) {
  const rows = db.prepare(`SELECT o.id, o.product_order_id, o.order_id, o.product_name, o.option_name, o.cleaned_name,
    o.sku_barcode, o.naming_status, o.state, o.quantity, o.review_revision, o.source_hash, (SELECT s.source_json FROM order_intake_snapshots s
      WHERE s.item_id = o.id ORDER BY s.id DESC LIMIT 1) AS source_json
    FROM order_intake_items o WHERE (o.state = 'pending' AND o.quantity > 0) OR EXISTS (
      SELECT 1 FROM order_packing_items i JOIN order_packing_boxes b ON b.id = i.box_id
      WHERE i.order_item_id = o.id AND b.removed_revision IS NULL) ORDER BY o.id`).all();
  const items = db.prepare(`SELECT b.id AS box_id, b.destination_hash, i.order_item_id, i.quantity
    FROM order_packing_boxes b JOIN order_packing_items i ON i.box_id = b.id
    WHERE b.removed_revision IS NULL ORDER BY b.id, i.order_item_id`).all();
  const lastRevision = db.prepare('SELECT MAX(id) AS id FROM order_packing_revisions').get().id;
  const orders = new Map(rows.map(row => [row.id, { id: row.id, productOrderId: row.product_order_id, orderId: row.order_id,
    productName: row.product_name, optionName: row.option_name, cleanedName: row.cleaned_name, skuBarcode: row.sku_barcode,
    namingStatus: row.naming_status,
    state: row.state, quantity: row.quantity, ...destination(row.source_json) }]));
  const boxes = new Map();
  for (const item of items) {
    if (!boxes.has(item.box_id)) boxes.set(item.box_id, { id: item.box_id, destinationHash: item.destination_hash, items: [] });
    boxes.get(item.box_id).items.push({ orderItemId: item.order_item_id, quantity: item.quantity });
  }
  const version = digest([lastRevision, rows.map(row => [row.id, row.state, row.quantity, row.review_revision, row.source_hash])]);
  return { orders, boxes, version };
}

function allocations(boxes) {
  const quantities = new Map();
  for (const box of boxes) {
    for (const item of box.items) quantities.set(item.orderItemId, (quantities.get(item.orderItemId) || 0) + item.quantity);
  }
  return quantities;
}

function publicPacking({ orders, boxes, version }) {
  const quantities = allocations(boxes.values());
  const destinations = new Map();
  const publicOrders = [...orders.values()].map(({ destinationHash, ...order }) => {
    const allocatedQuantity = quantities.get(order.id) || 0;
    const availableQuantity = order.state === 'pending' ? Math.max(0, order.quantity - allocatedQuantity) : 0;
    if (destinationHash && !destinations.has(destinationHash)) destinations.set(destinationHash, destinations.size + 1);
    return { ...order, allocatedQuantity, availableQuantity, destinationReady: Boolean(destinationHash),
      destinationGroup: destinations.get(destinationHash) ?? null };
  });
  const publicBoxes = [...boxes.values()].map(({ destinationHash, ...box }) => ({ ...box, needsReview: !destinationHash
    || box.items.some(({ orderItemId }) => {
      const order = orders.get(orderItemId);
      return order.state !== 'pending' || order.quantity < quantities.get(orderItemId) || order.destinationHash !== destinationHash;
    }) }));
  return { version, orders: publicOrders, boxes: publicBoxes,
    summary: { boxCount: publicBoxes.length, reviewBoxCount: publicBoxes.filter(box => box.needsReview).length,
      allocatedQuantity: publicOrders.reduce((total, order) => total + order.allocatedQuantity, 0),
      unallocatedQuantity: publicOrders.reduce((total, order) => total + order.availableQuantity, 0) } };
}

export function getOrderPacking(db) {
  return publicPacking(readPacking(db));
}

export function reviseOrderPacking(db, { expectedVersion, removeBoxIds, boxes } = {}) {
  if (typeof expectedVersion !== 'string' || !/^[0-9a-f]{64}$/.test(expectedVersion)
    || !Array.isArray(removeBoxIds) || !Array.isArray(boxes) || (!removeBoxIds.length && !boxes.length)
    || !removeBoxIds.every(positiveInteger) || new Set(removeBoxIds).size !== removeBoxIds.length) {
    throw error('현재 포장 계획과 수정할 상자를 확인해 주세요.');
  }
  return transaction(db, () => {
    const current = readPacking(db);
    if (expectedVersion !== current.version || removeBoxIds.some(boxId => !current.boxes.has(boxId))) {
      throw error('주문 또는 포장 계획이 변경되었습니다. 다시 조회해 주세요.', 409);
    }
    const removed = new Set(removeBoxIds);
    const quantities = allocations([...current.boxes.values()].filter(box => !removed.has(box.id)));
    const plans = boxes.map(box => {
      if (!Array.isArray(box?.items) || !box.items.length) throw error('상자에 넣을 상품과 수량을 지정해 주세요.');
      const seen = new Set(), destinations = new Set();
      for (const item of box.items) {
        if (!positiveInteger(item?.orderItemId) || !positiveInteger(item.quantity) || seen.has(item.orderItemId)) {
          throw error('한 상자의 같은 주문 행은 한 번만 넣고 수량을 양의 정수로 지정해 주세요.');
        }
        const order = current.orders.get(item.orderItemId);
        if (!order || order.state !== 'pending') throw error('현재 포장 가능한 주문만 상자에 넣을 수 있습니다.');
        const previous = quantities.get(order.id) || 0;
        if (item.quantity > order.quantity - previous) throw error('상자에 배정한 수량이 주문의 잔여 수량을 초과합니다.');
        seen.add(order.id);
        destinations.add(order.destinationHash);
        quantities.set(order.id, previous + item.quantity);
      }
      if (seen.size > 1 && (destinations.size !== 1 || destinations.has(null))) {
        throw error('수취인과 전체 배송지가 모두 확인되고 서로 일치할 때만 합포장할 수 있습니다.');
      }
      return { destinationHash: [...destinations][0], items: box.items };
    });
    const revision = db.prepare('INSERT INTO order_packing_revisions (version_before, created_at) VALUES (?, ?)')
      .run(current.version, new Date().toISOString()).lastInsertRowid;
    const remove = db.prepare('UPDATE order_packing_boxes SET removed_revision = ? WHERE id = ?');
    const create = db.prepare('INSERT INTO order_packing_boxes (created_revision, destination_hash) VALUES (?, ?)');
    const add = db.prepare('INSERT INTO order_packing_items (box_id, order_item_id, quantity) VALUES (?, ?, ?)');
    for (const boxId of removeBoxIds) remove.run(revision, boxId);
    for (const plan of plans) {
      const { lastInsertRowid: boxId } = create.run(revision, plan.destinationHash);
      for (const item of plan.items) add.run(boxId, item.orderItemId, item.quantity);
    }
    return getOrderPacking(db);
  });
}
