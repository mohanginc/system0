import { transaction } from './database.mjs';

const canceledStatuses = new Set(['CANCELED', 'CANCELED_BY_NOPAYMENT']);
const cancelCompleted = new Set(['CANCEL_DONE', 'ADMIN_CANCEL_DONE']);
const cancelPending = new Set(['CANCEL_REQUEST', 'CANCELING', 'ADMIN_CANCELING']);
const saleStatuses = new Set(['PAYED', 'DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED']);
const resolvedClaims = new Set(['', 'CANCEL_REJECT', 'ADMIN_CANCEL_REJECT', 'RETURN_REJECT', 'EXCHANGE_REJECT',
  'PURCHASE_DECISION_HOLDBACK_RELEASE']);

const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const quantity = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const hold = (reason, unverified = false) => ({ state: 'hold', reason, unverified });

function registeredItems(db, from, to, includeQuantities = false) {
  return db.prepare(`SELECT i.dispatch_box_id, i.order_item_id, i.provider, i.product_order_id,
    o.order_id, o.store, o.quantity AS source_quantity, o.manual_canceled,
    CASE WHEN ? THEN (SELECT sum(allocation.quantity) FROM order_dispatch_items allocation
      WHERE allocation.order_item_id = i.order_item_id) END AS registered_quantity,
    c.dispatch_state, c.reason, c.unverified, c.checked_at, c.evidence_changed_at
    FROM order_dispatch_boxes b JOIN order_dispatch_items i ON i.dispatch_box_id = b.id
    JOIN order_intake_items o ON o.id = i.order_item_id
    LEFT JOIN order_dispatch_cancellations c ON c.dispatch_box_id = i.dispatch_box_id AND c.order_item_id = i.order_item_id
    WHERE b.registered_at >= ? AND b.registered_at < ? ORDER BY i.dispatch_box_id, i.order_item_id`).all(Number(includeQuantities), from, to);
}

function summarize(items, includeManual = false) {
  let lastCheckedAt = null;
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.dispatch_box_id)) grouped.set(item.dispatch_box_id, []);
    grouped.get(item.dispatch_box_id).push(item);
    if (item.checked_at && (!lastCheckedAt || item.checked_at > lastCheckedAt)) lastCheckedAt = item.checked_at;
  }
  const boxes = new Map();
  let unverifiedCount = 0;
  for (const [boxId, rows] of grouped) {
    if (!rows.some(row => row.provider === 'naver' || (includeManual && row.manual_canceled))) continue;
    const isCanceled = row => row.dispatch_state === 'canceled' || (includeManual && row.manual_canceled);
    if (rows.every(isCanceled)) {
      const dispatchReason = rows.every(row => row.dispatch_state === 'canceled') ? '네이버 주문 취소 완료' : '주문 관리에서 수동 취소';
      boxes.set(boxId, { dispatchState: 'canceled', dispatchReason });
      continue;
    }
    const canceled = rows.some(isCanceled);
    const held = rows.find(row => row.dispatch_state === 'hold');
    const dispatchReason = canceled ? '상자 안에 취소된 상품이 있습니다.' : held?.reason || '';
    if (rows.some(row => row.dispatch_state === 'hold' && row.unverified)) unverifiedCount++;
    boxes.set(boxId, { dispatchState: canceled || held ? 'hold' : 'ready', dispatchReason });
  }
  return { lastCheckedAt, boxes, unverifiedCount };
}

export function dispatchCancellationStates(db, from, to) {
  const { lastCheckedAt, boxes } = summarize(registeredItems(db, from, to), true);
  return { lastCheckedAt, boxes };
}

function observation(row, remote) {
  if (!remote) return hold('네이버 상품주문의 취소 상태를 확인하지 못했습니다.', true);
  const remain = quantity(remote.remainQuantity ?? remote.quantity);
  const original = quantity(remote.financial?.orderedQuantity);
  const claim = typeof remote.claimStatus === 'string' ? remote.claimStatus : '';
  if (remain === null || (original !== null && remain > original)) {
    return hold('네이버 상품주문의 수량을 확인하지 못했습니다.', true);
  }
  if (remain === 0 && (canceledStatuses.has(remote.status) || (remote.status === 'PAYED' && cancelCompleted.has(claim)))) {
    return { state: 'canceled', reason: '네이버 주문 취소 완료', unverified: false };
  }
  if (cancelPending.has(claim)) return hold('네이버 주문 취소 요청 또는 처리 중입니다.');
  if (remain > 0 && (cancelCompleted.has(claim) || remain < Math.max(original ?? 0, row.registered_quantity, row.source_quantity))) {
    return hold('일부 상품 수량이 취소되었거나 출고 수량과 다릅니다.');
  }
  if (!saleStatuses.has(remote.status) || remain === 0 || !resolvedClaims.has(claim)) {
    return hold('네이버 상품주문의 상태나 클레임을 확인해 주세요.');
  }
  return { state: 'ready', reason: '', unverified: false };
}

const scopeKey = row => JSON.stringify([row.store, row.order_id]);

export async function checkDispatchCancellations(db, from, to, naver) {
  const startedAt = new Date().toISOString();
  const targets = registeredItems(db, from, to, true).filter(item => item.provider === 'naver');
  const ids = [...new Set(targets.map(item => item.product_order_id))];
  const scopes = new Map();
  for (const item of targets) {
    if (!scopes.has(item.product_order_id)) scopes.set(item.product_order_id, new Set());
    scopes.get(item.product_order_id).add(scopeKey(item));
  }
  const response = ids.length ? await naver.queryProductOrders(ids, { includeIntake: true, allowMissing: true }) : [];
  if (!Array.isArray(response)) throw new Error('네이버 상품주문 상세 결과를 확인할 수 없습니다.');
  const remoteById = new Map();
  for (const remote of response) {
    const id = remote?.productOrderId;
    if (!scopes.has(id) || remoteById.has(id)) throw new Error('네이버 상품주문 조회 결과에 잘못되거나 중복된 주문번호가 있습니다.');
    remoteById.set(id, remote);
  }
  const checkedAt = new Date().toISOString();
  let matchedCount = 0;
  transaction(db, () => {
    const previous = db.prepare('SELECT * FROM order_dispatch_cancellations WHERE dispatch_box_id = ? AND order_item_id = ?');
    const save = db.prepare(`INSERT INTO order_dispatch_cancellations
      (dispatch_box_id,order_item_id,dispatch_state,reason,unverified,checked_at,query_started_at,evidence_changed_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(dispatch_box_id,order_item_id) DO UPDATE SET dispatch_state=excluded.dispatch_state,reason=excluded.reason,
        unverified=excluded.unverified,checked_at=excluded.checked_at,query_started_at=excluded.query_started_at,
        evidence_changed_at=excluded.evidence_changed_at`);
    for (const row of targets) {
      const remote = remoteById.get(row.product_order_id);
      const found = remote?.orderId === row.order_id && (remote.store && row.store !== 'default'
        ? remote.store === row.store : scopes.get(row.product_order_id).size === 1);
      if (found) matchedCount++;
      const result = observation(row, found ? remote : null);
      const changed = found ? timestamp(remote.changedAt) : null;
      const prior = previous.get(row.dispatch_box_id, row.order_item_id);
      if (prior?.query_started_at > startedAt) continue;
      const oldEvidence = prior?.evidence_changed_at;
      const keep = prior && (prior.dispatch_state === 'canceled' || (changed && oldEvidence && changed < oldEvidence)
        || (prior.dispatch_state === 'hold' && result.state === 'ready' && oldEvidence && (!changed || changed <= oldEvidence)));
      if (keep) {
        save.run(row.dispatch_box_id, row.order_item_id, prior.dispatch_state, prior.reason, prior.unverified, checkedAt, startedAt, oldEvidence);
      } else {
        save.run(row.dispatch_box_id, row.order_item_id, result.state, result.reason, Number(result.unverified), checkedAt,
          startedAt, changed || oldEvidence || null);
      }
    }
  });
  const { lastCheckedAt, boxes, unverifiedCount } = summarize(registeredItems(db, from, to));
  const counts = { ready: 0, hold: 0, canceled: 0 };
  for (const box of boxes.values()) counts[box.dispatchState]++;
  return { lastCheckedAt, naverBoxCount: boxes.size, queriedCount: ids.length, matchedCount, readyCount: counts.ready,
    holdCount: counts.hold, canceledCount: counts.canceled, unverifiedCount, missingCount: targets.length - matchedCount };
}
