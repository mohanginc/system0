import { createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { namingVersion, normalizePreviewNames } from './naming.mjs';
import { barcodeForName, shipmentType, validBarcode } from './sku.mjs';
import { mostFrequentName } from './shipping.mjs';
import { parseCoupangOrders } from './coupang-orders.mjs';
import { registeredOrderQuantities } from './order-packing.mjs';

const text = value => typeof value === 'string' ? value.trim() : '';
const validId = value => typeof value === 'string' && value === value.trim() && value.length <= 150 && /^[A-Za-z0-9_-]+$/.test(value);
const amount = value => Number.isSafeInteger(value) ? value : null;
const timestamp = value => text(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const timeNow = () => new Date().toISOString();
const financialFields = [
  'orderedQuantity', 'unitPrice', 'optionPrice', 'initialProductAmount', 'productAmount', 'initialPaymentAmount', 'paymentAmount',
  'initialProductDiscountAmount', 'productDiscountAmount', 'initialSellerDiscountAmount', 'sellerDiscountAmount', 'platformDiscountAmount',
  'shippingFeeAmount', 'shippingExtraAmount', 'shippingDiscountAmount', 'paymentCommissionAmount', 'saleCommissionAmount',
  'channelCommissionAmount', 'commissionAmount', 'expectedSettlementAmount', 'settlementAmount',
];
const claimsRequiringReview = new Set(['CANCEL_REQUEST', 'CANCELING', 'ADMIN_CANCELING', 'RETURN_REQUEST', 'EXCHANGE_REQUEST', 'COLLECTING',
  'COLLECT_DONE', 'EXCHANGE_REDELIVERING', 'RETURN_HOLD', 'EXCHANGE_HOLD']);

function scope({ provider = 'all', store = 'default' } = {}) {
  if (!['all', 'naver', 'coupang'].includes(provider) || !validId(store)) throw Object.assign(new Error('연결된 판매채널을 확인해 주세요.'), { status: 400 });
  return { provider, store };
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  return value;
}

function collectedOrder(incoming, prior, sourceMethod, defaultStore) {
  const fromFile = sourceMethod === 'file';
  const channel = fromFile ? '쿠팡' : '네이버';
  const productOrderId = incoming?.productOrderId, orderId = incoming?.orderId;
  const quantity = amount(incoming?.quantity ?? incoming?.remainQuantity);
  const status = text(incoming?.status) || (sourceMethod === 'list' ? 'PAYED' : '');
  const placeOrderStatus = text(incoming?.placeOrderStatus) || (sourceMethod === 'list' ? 'NOT_YET' : '');
  const originalName = text(incoming?.originalName) || text(incoming?.productName) || prior?.original_name || '';
  if (!validId(productOrderId) || !validId(orderId) || quantity === null || quantity < 0 || !status || !originalName) {
    throw new Error(`${channel} 상품주문번호·상품명·잔여 수량을 확인할 수 없습니다.`);
  }
  const store = text(incoming.store) || prior?.store || defaultStore;
  if (!validId(store)) throw new Error(`${channel} 주문의 스토어를 확인할 수 없습니다.`);
  const old = prior && JSON.parse(prior.order_json);
  const financial = { currency: 'KRW' };
  for (const field of financialFields) financial[field] = amount(incoming.financial?.[field]);
  const claimStatus = text(incoming.claimStatus), giftReceivingStatus = text(incoming.giftReceivingStatus);
  let state = fromFile ? incoming.state : 'closed';
  if (!fromFile && status === 'PAYED' && quantity > 0) {
    if (!placeOrderStatus) state = 'unverified';
    else if (placeOrderStatus === 'NOT_YET') {
      state = claimsRequiringReview.has(claimStatus) || giftReceivingStatus === 'WAIT_FOR_RECEIVING' ? 'hold' : 'pending';
    }
  }
  return { store, productOrderId, orderId, collectionMethod: fromFile ? 'file' : 'api', state, quantity, status, placeOrderStatus, claimStatus, giftReceivingStatus,
    claimType: text(incoming.claimType), originalName,
    productName: text(incoming.productName) || originalName,
    optionName: typeof incoming.optionName === 'string' && (incoming.optionName || incoming.productName || sourceMethod === 'list')
      ? incoming.optionName.trim() : prior?.option_name || '',
    orderedAt: timestamp(incoming.orderedAt) || prior?.ordered_at || null,
    paidAt: timestamp(incoming.paidAt) || prior?.paid_at || null,
    changedAt: timestamp(incoming.changedAt),
    externalProductId: text(incoming.externalProductId) || old?.externalProductId || '',
    originalProductId: text(incoming.originalProductId) || old?.originalProductId || '',
    externalOptionId: text(incoming.externalOptionId) || old?.externalOptionId || '',
    sellerProductCode: text(incoming.sellerProductCode) || old?.sellerProductCode || '',
    sellerOptionCode: text(incoming.sellerOptionCode) || old?.sellerOptionCode || '',
    shippingGroupId: text(incoming.shippingGroupId) || old?.shippingGroupId || '',
    ...(fromFile ? { nativeProductOrderId: incoming.nativeProductOrderId || null, sourceBarcode: incoming.sourceBarcode } : {}),
    financial,
  };
}

const scopedItems = (db, { provider, store }) => db.prepare(`SELECT * FROM order_intake_items
  WHERE (? = 'all' OR provider = ?) AND (? = 'default' OR store = ?) AND state <> 'closed'
  ORDER BY COALESCE(paid_at, ordered_at, first_seen_at) DESC, id DESC`).all(provider, provider, store, store);

function publicOrder(row, registeredQuantity = 0) {
  const { state, ...data } = JSON.parse(row.order_json);
  const totalCost = row.unit_cost_krw === null ? null : row.unit_cost_krw * row.quantity;
  return { ...data, id: row.id, provider: row.provider, state: row.state, sourceMethod: row.source_method,
    sourceQuantity: row.quantity, registeredQuantity, quantity: Math.max(0, row.quantity - registeredQuantity),
    cleanedName: row.cleaned_name, namingStatus: row.naming_status, namingNote: row.naming_note, namingSource: row.naming_source,
    skuBarcode: row.sku_barcode, manualSkuBarcode: row.manual_sku_barcode,
    cost: { unitCost: row.unit_cost_krw, effectiveDate: row.cost_effective_date,
      totalCost: Number.isSafeInteger(totalCost) ? totalCost : null },
    firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, reviewVersion: String(row.review_revision) };
}

function shippingGroups(orders) {
  const groups = new Map();
  let quantity = 0, attentionQuantity = 0;
  for (const order of orders) {
    const name = order.cleanedName || order.originalName, type = shipmentType(name, order.originalName);
    const unprepared = !order.cleanedName, needsAttention = unprepared || order.namingStatus === 'attention' || !order.skuBarcode;
    const key = JSON.stringify([order.skuBarcode ? 'sku' : 'name', order.skuBarcode || name, type]);
    if (!groups.has(key)) groups.set(key, { key, name, skuBarcode: order.skuBarcode, shipmentType: type,
      needsAttention: false, unprepared: false, count: 0, shipments: [], names: new Map() });
    const group = groups.get(key);
    group.needsAttention ||= needsAttention;
    group.unprepared ||= unprepared;
    group.count += order.quantity;
    group.names.set(name, (group.names.get(name) || 0) + 1);
    group.shipments.push({ id: order.id, productOrderId: order.productOrderId, orderId: order.orderId, store: order.store,
      provider: order.provider, quantity: order.quantity, note: order.namingNote });
    quantity += order.quantity;
    if (needsAttention) attentionQuantity += order.quantity;
  }
  return { quantity, attentionQuantity, groups: [...groups.values()].map(({ names, ...group }) => ({ ...group, name: mostFrequentName(names) }))
    .sort((a, b) => Number(a.needsAttention) - Number(b.needsAttention) || b.count - a.count || a.name.localeCompare(b.name, 'ko')) };
}

export function getOrderIntake(db, options) {
  const selected = scope(options);
  const sync = db.prepare('SELECT * FROM order_intake_syncs WHERE provider = ? AND store = ?');
  const providers = Object.fromEntries(['naver', 'coupang'].map(provider => {
    const run = sync.get(provider, selected.store);
    return [provider, { from: run?.range_from ?? null, to: run?.range_to ?? null, updatedAt: run?.updated_at ?? null }];
  }));
  const run = providers[selected.provider === 'all' ? 'naver' : selected.provider];
  const updatedAt = selected.provider === 'all' ? [providers.naver.updatedAt, providers.coupang.updatedAt].filter(Boolean).sort().at(-1) ?? null : run.updatedAt;
  const registered = registeredOrderQuantities(db);
  const orders = scopedItems(db, selected).map(row => publicOrder(row, registered.get(row.id) || 0))
    .filter(order => order.quantity > 0 || (order.state !== 'pending' && order.registeredQuantity === 0));
  const pending = orders.filter(order => order.state === 'pending');
  const { groups, quantity, attentionQuantity } = shippingGroups(pending);
  return { ...selected, from: run.from, to: run.to, updatedAt, collectedAt: updatedAt, providers, orders, groups,
    summary: { orderCount: new Set(pending.map(order => JSON.stringify([order.provider, order.store, order.orderId]))).size,
      rowCount: pending.length, quantity, attentionQuantity, groupCount: groups.length,
      pendingCount: pending.filter(order => order.namingStatus === 'pending').length,
      heldCount: orders.filter(order => order.state === 'hold').length,
      unverifiedCount: orders.filter(order => order.state === 'unverified').length } };
}

function optionIdentity(order) {
  const product = order.externalProductId || order.originalProductId;
  const option = order.sellerOptionCode || order.externalOptionId;
  return product && (option || !order.optionName) ? JSON.stringify([product, option]) : null;
}

export function refreshIntakeSkus(db) {
  const records = db.prepare(`SELECT * FROM order_intake_items WHERE state <> 'closed'
    OR (sku_barcode IS NOT NULL AND unit_cost_krw IS NULL) OR manual_sku_barcode IS NOT NULL`).all();
  const activeSku = db.prepare('SELECT barcode FROM sku_products WHERE barcode = ? AND enabled = 1');
  const lookupCost = db.prepare(`SELECT effective_date, unit_cost_krw FROM sku_costs
    WHERE barcode = ? AND effective_date <= ? ORDER BY effective_date DESC LIMIT 1`);
  const change = db.prepare(`UPDATE order_intake_items SET sku_barcode = ?, unit_cost_krw = ?, cost_effective_date = ?,
    review_revision = review_revision + 1 WHERE id = ?`);
  const approved = new Map();
  for (const row of records) {
    if (!row.manual_sku_barcode || row.naming_status !== 'confirmed') continue;
    const identity = optionIdentity(JSON.parse(row.order_json));
    if (!identity) continue;
    const key = JSON.stringify([row.provider, row.store, identity]);
    if (!approved.has(key)) approved.set(key, new Set());
    approved.get(key).add(row.manual_sku_barcode);
  }
  for (const row of records) {
    const order = JSON.parse(row.order_json), identity = optionIdentity(order);
    const approvedCodes = approved.get(JSON.stringify([row.provider, row.store, identity]));
    const sourceCode = order.sourceBarcode || order.sellerOptionCode || (order.optionName ? '' : order.sellerProductCode);
    const sourceSku = validBarcode(sourceCode) ? activeSku.get(sourceCode)?.barcode : null;
    const approvedSku = approvedCodes?.size === 1 ? activeSku.get([...approvedCodes][0])?.barcode : null;
    const linkedSku = row.manual_sku_barcode || approvedSku || sourceSku || barcodeForName(row.cleaned_name, db);
    if (row.state === 'closed' && row.sku_barcode !== linkedSku) continue;
    const date = order.paidAt || order.orderedAt;
    const orderDate = date ? new Date(Date.parse(date) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
    const cost = linkedSku === row.sku_barcode && row.unit_cost_krw !== null
      ? { unit_cost_krw: row.unit_cost_krw, effective_date: row.cost_effective_date }
      : linkedSku && orderDate ? lookupCost.get(linkedSku, orderDate) : null;
    const unitCost = cost?.unit_cost_krw ?? null, effectiveDate = cost?.effective_date ?? null;
    if (row.sku_barcode !== linkedSku || row.unit_cost_krw !== unitCost || row.cost_effective_date !== effectiveDate) {
      change.run(linkedSku, unitCost, effectiveDate, row.id);
    }
  }
}

const busy = new WeakSet();

async function whileIdle(db, action) {
  if (busy.has(db)) throw Object.assign(new Error('주문 가져오기 또는 상품명 정리 중입니다.'), { status: 409 });
  busy.add(db);
  try { return await action(); }
  finally { busy.delete(db); }
}

function saveCollection(db, selected, snapshot, missing, details) {
  const now = timeNow(), { provider, store } = selected;
  const fileImport = provider === 'coupang';
  const channel = fileImport ? '쿠팡' : '네이버';
  const collection = { added: 0, updated: 0, unchanged: 0, unverified: 0 };
  const byIdentity = db.prepare('SELECT * FROM order_intake_items WHERE provider = ? AND store = ? AND product_order_id = ?');
  const byProduct = db.prepare('SELECT * FROM order_intake_items WHERE provider = ? AND product_order_id = ?');
  const add = db.prepare(`INSERT INTO order_intake_items (provider, store, product_order_id, order_id, state,
    quantity, ordered_at, paid_at, original_name, product_name, option_name, order_json, source_hash, source_method, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE order_intake_items SET store = ?, order_id = ?, state = ?, quantity = ?, ordered_at = ?, paid_at = ?,
    original_name = ?, product_name = ?, option_name = ?, order_json = ?, source_hash = ?, source_method = ?, last_seen_at = ?,
    cleaned_name = ?, naming_status = ?, naming_note = ?, naming_source = ?, naming_version = ?,
    review_revision = review_revision + 1 WHERE id = ?`);
  const seen = db.prepare('UPDATE order_intake_items SET last_seen_at = ? WHERE id = ?');
  const unverified = db.prepare(`UPDATE order_intake_items SET state = 'unverified', review_revision = review_revision + 1
    WHERE id = ? AND state NOT IN ('closed', 'unverified')`);
  const addSnapshot = db.prepare('INSERT INTO order_intake_snapshots (item_id, source_method, source_json, recorded_at) VALUES (?, ?, ?, ?)');
  const olderFile = fileImport && db.prepare(`SELECT 1 FROM order_intake_snapshots
    WHERE item_id = ? AND source_method = 'file' AND json_extract(source_json,'$.evidenceHash') = ? LIMIT 1`);
  const addSync = db.prepare(`INSERT INTO order_intake_syncs (provider, store, range_from, range_to, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider, store) DO UPDATE SET range_from = excluded.range_from, range_to = excluded.range_to, updated_at = excluded.updated_at`);

  function save(incoming, source, prior) {
    const incomingStore = text(incoming.store);
    if (store !== 'default' && incomingStore && incomingStore !== store) return;
    if (prior) prior = byIdentity.get(provider, prior.store, prior.product_order_id);
    else {
      prior = byIdentity.get(provider, incomingStore || store, incoming.productOrderId);
      if (!prior) {
        const matches = byProduct.all(provider, incoming.productOrderId);
        if (!incomingStore && matches.length > 1) throw new Error('같은 상품주문번호의 판매채널을 확인할 수 없습니다.');
        if (matches.length === 1 && (!incomingStore || matches[0].store === 'default')) prior = matches[0];
      }
    }
    if (prior && (prior.order_id !== incoming.orderId || incomingStore && prior.store !== 'default' && prior.store !== incomingStore)) {
      throw new Error(`같은 상품주문의 스토어 또는 주문번호가 변경되었습니다. ${channel} 원본을 확인해 주세요.`);
    }
    const order = collectedOrder(incoming, prior, source, store);
    if (store !== 'default' && order.store !== store) return;
    const oldChanged = prior && JSON.parse(prior.order_json).changedAt;
    if (oldChanged && order.changedAt && oldChanged > order.changedAt) {
      collection.unchanged++;
      return;
    }
    const orderJson = JSON.stringify(order), sourceJson = JSON.stringify(incoming.sourcePayload ?? incoming);
    const hash = fileImport ? incoming.sourcePayload.evidenceHash
      : createHash('sha256').update(JSON.stringify(stableJson(JSON.parse(sourceJson)))).digest('hex');
    if (fileImport && prior && prior.source_hash !== hash
      && (olderFile.get(prior.id, hash) || (prior.state === 'closed' && order.state !== 'closed')
        || (prior.state === 'hold' && order.state === 'pending'))) {
      collection.unchanged++;
      return;
    }
    if (prior && prior.order_json === orderJson && prior.source_hash === hash && prior.state === order.state) {
      seen.run(now, prior.id);
      collection.unchanged++;
      return;
    }
    const fields = [order.store, order.orderId, order.state, order.quantity, order.orderedAt, order.paidAt,
      order.originalName, order.productName, order.optionName, orderJson, hash, source, now];
    if (prior) {
      const changedInput = prior.original_name !== order.originalName || prior.product_name !== order.productName || prior.option_name !== order.optionName;
      const staffReview = prior.naming_source === 'manual' || prior.manual_sku_barcode;
      const namingFields = changedInput && !staffReview ? ['', 'pending', '', '', '']
        : [prior.cleaned_name, changedInput ? 'attention' : prior.naming_status,
          changedInput ? `${channel} 상품명·옵션이 변경되어 연결을 다시 확인해 주세요.` : prior.naming_note,
          prior.naming_source, prior.naming_version];
      update.run(...fields, ...namingFields, prior.id);
      if (prior.source_hash !== hash) addSnapshot.run(prior.id, source, sourceJson, now);
      collection.updated++;
    } else {
      const { lastInsertRowid } = add.run(provider, order.store, order.productOrderId, ...fields.slice(1), now);
      addSnapshot.run(lastInsertRowid, source, sourceJson, now);
      collection.added++;
    }
  }

  const detailsById = new Map();
  for (const order of details) {
    if (!detailsById.has(order.productOrderId)) detailsById.set(order.productOrderId, []);
    detailsById.get(order.productOrderId).push(order);
  }
  transaction(db, () => {
    for (const order of snapshot.orders) save(order, fileImport ? 'file' : 'list');
    for (const prior of missing) {
      const matches = (detailsById.get(prior.product_order_id) || []).filter(order =>
        (!order.store || prior.store === 'default' || order.store === prior.store) && order.orderId === prior.order_id);
      if (matches.length === 1 && (matches[0].store || byProduct.all(provider, prior.product_order_id).length === 1)) {
        save(matches[0], 'detail', prior);
      } else {
        unverified.run(prior.id);
        collection.unverified++;
      }
    }
    addSync.run(provider, store, timestamp(snapshot.from), timestamp(snapshot.to), now);
    refreshIntakeSkus(db);
  });
  return collection;
}

async function namePending(db, selected, client, model) {
  const registered = registeredOrderQuantities(db);
  const candidates = scopedItems(db, selected).filter(row => row.state === 'pending' && row.naming_status === 'pending'
    && row.quantity > (registered.get(row.id) || 0));
  if (!candidates.length) return;
  const prior = db.prepare(`SELECT * FROM order_intake_items WHERE original_name = ? AND option_name = ? AND naming_version = ?
    AND cleaned_name <> '' AND naming_status IN ('confirmed', 'review', 'attention')
    ORDER BY (naming_status = 'confirmed') DESC, (naming_source = 'manual') DESC, id DESC LIMIT 1`);
  const update = db.prepare(`UPDATE order_intake_items SET cleaned_name = ?, naming_status = ?, naming_note = ?, naming_source = ?,
    naming_version = ?, review_revision = review_revision + 1
    WHERE id = ? AND state = 'pending' AND naming_status = 'pending' AND review_revision = ?`);
  const groups = new Map(), unique = [];
  for (const row of candidates) {
    const key = JSON.stringify([row.original_name, row.option_name]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  transaction(db, () => {
    for (const rows of groups.values()) {
      const source = prior.get(rows[0].original_name, rows[0].option_name, namingVersion);
      if (!source) { unique.push(rows); continue; }
      for (const row of rows) update.run(source.cleaned_name, source.naming_status === 'attention' ? 'attention' : 'review',
        source.naming_note, 'reused', namingVersion, row.id, row.review_revision);
    }
    refreshIntakeSkus(db);
  });
  for (let start = 0; start < unique.length; start += 20) {
    const chunk = unique.slice(start, start + 20);
    const result = await normalizePreviewNames(db, chunk.map(([row]) => ({ id: row.id, originalName: row.original_name,
      productName: row.product_name, optionName: row.option_name })), client, model, { purposeCode: 'product_names' });
    transaction(db, () => {
      for (const [index, name] of result.entries()) {
        for (const row of chunk[index]) update.run(name.cleanedName, name.needsAttention ? 'attention' : 'review', name.note,
          name.source, namingVersion, row.id, row.review_revision);
      }
      refreshIntakeSkus(db);
    });
  }
}

async function nameAndRead(db, selected, client, model) {
  let namingError;
  try { await namePending(db, selected, client, model); }
  catch (error) { namingError = error.message; }
  return { ...getOrderIntake(db, { store: selected.store }), ...(namingError ? { namingError } : {}) };
}

export async function collectOrderIntake(db, { naver, client, model, lookbackDays, ...options } = {}) {
  if (options.provider !== undefined && options.provider !== 'naver') {
    throw Object.assign(new Error('네이버 주문 조회 범위를 확인해 주세요.'), { status: 400 });
  }
  const selected = scope({ ...options, provider: 'naver' });
  if (lookbackDays !== undefined && (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 180)) {
    throw Object.assign(new Error('조회 기간은 1일에서 180일까지 지정할 수 있습니다.'), { status: 400 });
  }
  return whileIdle(db, async () => {
    const snapshot = await naver.listNewOrders({ includeIntake: true, ...(lookbackDays === undefined ? {} : { lookbackDays }) });
    if (!Array.isArray(snapshot?.orders)) throw new Error('네이버 상품주문 목록을 확인할 수 없습니다.');
    const known = new Set(), knownIds = new Set();
    for (const order of snapshot.orders) {
      const normalized = collectedOrder(order, null, 'list', selected.store);
      const key = JSON.stringify([normalized.store, normalized.productOrderId]);
      if (known.has(key)) throw new Error('네이버 상품주문이 목록에 중복되었습니다.');
      known.add(key);
      knownIds.add(normalized.productOrderId);
    }
    const missing = scopedItems(db, selected).filter(row => !known.has(JSON.stringify([row.store, row.product_order_id]))
      && !known.has(JSON.stringify(['default', row.product_order_id]))
      && !(row.store === 'default' && knownIds.has(row.product_order_id)));
    let details = [];
    if (missing.length) {
      try {
        const ids = new Set(missing.map(row => row.product_order_id));
        const checked = await naver.queryProductOrders([...ids], { includeIntake: true, allowMissing: true });
        if (!Array.isArray(checked)) throw new Error('네이버 상품주문 상세 응답을 확인할 수 없습니다.');
        details = checked.filter(order => order && ids.has(order.productOrderId));
      } catch { /* 목록에 없다는 정보만으로 기존 주문의 상태를 확정하지 않습니다. */ }
    }
    const collection = saveCollection(db, selected, snapshot, missing, details);
    return { ...(await nameAndRead(db, selected, client, model)), collection };
  });
}

export function importCoupangOrders(db, { file, client, model, store = 'default' } = {}) {
  const selected = scope({ provider: 'coupang', store });
  return whileIdle(db, async () => {
    const orders = parseCoupangOrders(file).map(order => ({ ...order, store }));
    const collection = saveCollection(db, selected, { orders }, [], []);
    return { ...(await nameAndRead(db, selected, client, model)), collection: { ...collection,
      closed: orders.filter(order => order.state === 'closed').length, held: orders.filter(order => order.state === 'hold').length } };
  });
}

export function normalizeOrderIntake(db, { client, model, ...options } = {}) {
  const selected = scope(options);
  return whileIdle(db, () => nameAndRead(db, selected, client, model));
}

export function reviseOrderIntake(db, id, { cleanedName, skuBarcode, expected } = {}) {
  const get = db.prepare('SELECT * FROM order_intake_items WHERE id = ?');
  const unavailable = () => Object.assign(new Error('수정할 주문을 찾을 수 없습니다.'), { status: 404 });
  if (!Number.isSafeInteger(id) || id < 1) throw unavailable();
  if ((cleanedName == null && skuBarcode == null) || (cleanedName != null && (typeof cleanedName !== 'string' || !cleanedName.trim() || cleanedName.trim().length > 500))
    || (skuBarcode != null && skuBarcode !== '' && !validBarcode(skuBarcode))) {
    throw Object.assign(new Error('정리된 상품명 또는 등록된 상품의 바코드를 확인해 주세요.'), { status: 400 });
  }
  return transaction(db, () => {
    const prior = get.get(id);
    if (!prior) throw unavailable();
    const registered = registeredOrderQuantities(db).get(prior.id) || 0;
    if (expected !== String(prior.review_revision) || prior.state === 'closed' || (registered > 0 && registered >= prior.quantity)) {
      throw Object.assign(new Error('주문 상태가 변경되었습니다. 다시 불러온 뒤 수정해 주세요.'), { status: 409 });
    }
    if (skuBarcode && !db.prepare('SELECT barcode FROM sku_products WHERE barcode = ? AND enabled = 1').get(skuBarcode)) {
      throw Object.assign(new Error('등록된 상품의 바코드를 확인해 주세요.'), { status: 400 });
    }
    const hasName = cleanedName != null;
    db.prepare(`UPDATE order_intake_items SET cleaned_name = ?, naming_status = ?, naming_note = ?, naming_source = ?, naming_version = ?,
      manual_sku_barcode = ?, review_revision = review_revision + 1 WHERE id = ?`).run(
      hasName ? cleanedName.trim() : prior.cleaned_name, hasName ? 'confirmed' : prior.naming_status,
      hasName ? '' : prior.naming_note, hasName ? 'manual' : prior.naming_source, hasName ? namingVersion : prior.naming_version,
      skuBarcode == null ? prior.manual_sku_barcode : skuBarcode || null, id);
    refreshIntakeSkus(db);
    db.prepare('INSERT INTO order_intake_reviews (item_id, before_json, after_json, recorded_at) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify(publicOrder(prior)), JSON.stringify(publicOrder(get.get(id))), timeNow());
    return getOrderIntake(db);
  });
}
