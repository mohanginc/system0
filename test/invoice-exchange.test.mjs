import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { sourceFile, naverFile, courierFile, registeredOrder } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `system0-exchange-absent-${randomUUID()}.env`);
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact = value => String(value ?? '').normalize('NFC').replace(/\s/g, '');
const phone = value => String(value ?? '').replace(/[^0-9*]/g, '');
const sale = (index = 1) => ({ productOrderId: `202611050000000${index}`, orderId: `202611050001000${index}`,
  internalId: `SALE-${index}`, trackingNumber: `99000500000${index}`, recipient: `가상 수취인 ${index}`, phone: '010-0000-0001',
  address: '서울 테스트구 테스트로 1 101호', productName: '가상 쿠션 17cm', quantity: 1 });
const exchange = original => ({ ...original, internalId: '', productName: '[맞교환] 가상 쿠션 17cm → 15cm', phone: '050-0000-0002' });

async function boot(t, originals) {
  const remote = new Map(originals.map(order => [order.productOrderId, order]));
  const calls = { lookup: [], details: [] }, facts = [];
  const naver = { getProductOrderIds: async id => { calls.lookup.push(id); return [...remote.values()].filter(order => order.orderId === id).map(order => order.productOrderId); },
    queryProductOrders: async ids => { calls.details.push([...ids]); return ids.map(id => { assert.ok(remote.has(id)); return registeredOrder(remote.get(id)); }); } };
  const app = createApp({ databasePath: ':memory:', apiKey: '', client: null, publicOrigin: '', naver });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${server.address().port}`, db = app.locals.db;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); db.close(); });
  const request = (route, options) => { assert.ok(route.startsWith('/api/')); return fetch(base + route, options); };
  const read = async route => { const response = await request(route); assert.equal(response.status, 200); return response.json(); };
  const add = async (orders, date) => {
    const file = sourceFile(orders, `가상_${date}_${facts.length}.xlsx`), body = new FormData();
    body.append('files', new Blob([file.buffer]), file.name);
    const response = await request('/api/import', { method: 'POST', body }), added = await response.json(); assert.equal(response.status, 201, added.error);
    const createdAt = `${date}T00:00:00.000Z`; db.prepare('UPDATE batches SET created_at=? WHERE id=?').run(createdAt, added.batch.id);
    const reviewed = await request(`/api/batches/${added.batch.id}/rows`, json('PATCH', { changes: added.rows.map((row, i) => ({
      id: row.id, cleanedName: orders[i].cleanedName || orders[i].productName, reviewNote: '', status: 'confirmed' })) }));
    assert.equal(reviewed.status, 200);
    const rows = await read(`/api/invoices/orders?batchIds=${encodeURIComponent(JSON.stringify([added.batch.id]))}`);
    for (let i = 0; i < orders.length; i++) facts.push({ ...orders[i], cleanedName: orders[i].cleanedName || orders[i].productName,
      rowId: added.rows[i].id, batchId: added.batch.id, createdAt, source: rows.orders[i].source });
    return added;
  };
  const match = async (targets, parcels, date = '2026-11-05') => {
    const body = new FormData(), naver = naverFile(targets), courier = courierFile(parcels);
    body.append('naverFiles', new Blob([naver.buffer]), naver.name); body.append('courierFiles', new Blob([courier.buffer]), courier.name);
    body.append('sourceDate', date); body.append('deliveryCompanyCode', 'KGB');
    const response = await request('/api/invoices/import', { method: 'POST', body }), detail = await response.json(); assert.equal(response.status, 201, detail.error);
    db.prepare('UPDATE invoice_runs SET created_at=? WHERE id=?').run(`${date}T03:00:00.000Z`, detail.run.id);
    return read(`/api/invoices/${detail.run.id}`);
  };
  const day = async batch => (await read(`/api/invoices/orders?batchIds=${encodeURIComponent(JSON.stringify([batch.batch.id]))}`)).orders;
  const check = async run => { const response = await request(`/api/invoices/${run.run.id}/check`, { method: 'POST' }); const result = await response.json(); assert.equal(response.status, 200, result.error); return result; };
  const bytes = async (id, action = 'export') => { const response = await request(`/api/invoices/${id}/${action}`); assert.equal(response.status, 200, await response.clone().text()); return Buffer.from(await response.arrayBuffer()); };
  return { db, facts, calls, add, match, day, check, bytes, read, request };
}

// These are the persisted c057/9843 hash contracts, before exchange dispatches were separated.
function oldSignature(rows) {
  return hash(rows.map(row => JSON.stringify([row.rowId, row.internalId, row.orderId, true,
    compact(row.recipient), phone(row.phone), compact(row.address), row.productName])).sort());
}
function oldSourceBinding(orderId, sources, rows) {
  const ids = new Set(sources.map(row => row.rowId)), selected = rows.filter(row => ids.has(row.rowId));
  const internal = new Set(selected.map(row => row.internalId).filter(Boolean));
  const basis = row => [row.internalId, row.orderId, true, true, compact(row.recipient), phone(row.phone), compact(row.address), row.quantity, compact(row.cleanedName)];
  const related = rows.filter(row => row.orderId === orderId || internal.has(row.internalId));
  return hash([[...ids].sort((a, b) => a - b), selected.map(row => [row.rowId, ...basis(row)]), [...new Set(related.map(row => JSON.stringify(basis(row))))].sort()]);
}
function oldOutsideBinding(row, rows) {
  return hash([oldSignature([row]), row.quantity, row.createdAt, oldSignature(rows.filter(other => other.orderId === row.orderId || row.internalId && other.internalId === row.internalId))]);
}
function persistOldContract(h, id, version) {
  const run = h.db.prepare('SELECT * FROM invoice_runs WHERE id=?').get(id), scope = JSON.parse(run.scope_json);
  const saved = h.facts.filter(row => row.createdAt <= run.created_at);
  const matching = saved.filter(row => scope.orderIds.includes(row.orderId));
  scope.batchIds = [...new Set(matching.map(row => row.batchId))]; scope.sourceRowIds = matching.map(row => row.rowId);
  for (const item of h.db.prepare('SELECT * FROM invoice_items WHERE run_id=?').all(id)) {
    const expected = JSON.parse(item.expected_json), sources = JSON.parse(item.source_rows_json);
    if (version === 'c057') delete expected.sourceBinding;
    else expected.sourceBinding = oldSourceBinding(item.order_id, sources, saved);
    h.db.prepare('UPDATE invoice_items SET expected_json=? WHERE id=?').run(JSON.stringify(expected), item.id);
  }
  for (const proof of scope.outsideOrders || []) {
    const row = saved.find(row => row.rowId === proof.rowId); proof.checkedAt = run.created_at;
    proof.binding = oldOutsideBinding(row, saved);
    if (version === 'c057') delete proof.sourceBinding;
    else proof.sourceBinding = oldSourceBinding(row.orderId, [row.source], saved);
  }
  const evidence = saved.filter(row => scope.orderIds.includes(row.orderId) || scope.evidenceInternalIds.includes(row.internalId));
  h.db.prepare('UPDATE invoice_runs SET legacy_signature=?,scope_json=? WHERE id=?').run(oldSignature(evidence), JSON.stringify(scope), id);
}

test('맞교환은 원판매 완료·원본·생성 파일을 바꾸지 않고 별도 출고와 출고번호 오류로 표시한다', async t => {
  const original = sale(), current = sale(2), h = await boot(t, [original, current]);
  const originalBatch = await h.add([original], '2026-11-05'), initial = await h.match([original], [original]);
  const bytes = await h.bytes(initial.run.id); await h.check(initial);
  const savedRow = h.db.prepare('SELECT * FROM rows WHERE id=?').get(originalBatch.rows[0].id);
  const extra = await h.add([exchange(original), current], '2026-11-07');
  let detail = await h.read(`/api/invoices/${initial.run.id}`);
  assert.equal(detail.items[0].registrationState, 'complete'); assert.equal(detail.items[0].statusFresh, true);
  assert.ok(!detail.issues.some(issue => issue.kind === 'source_changed'));
  assert.equal((await h.day(originalBatch))[0].state, 'complete');
  const separate = (await h.day(extra))[0];
  assert.equal(separate.state, 'exchange'); assert.equal(separate.shipmentType, 'exchange');
  assert.match(separate.reason, /내부 출고번호.*비어/); assert.deepEqual(separate.itemIds, []); assert.deepEqual(separate.trackingNumbers, []);
  h.calls.lookup.length = 0; h.calls.details.length = 0;
  detail = await h.match([current], [current], '2026-11-07');
  assert.equal(detail.outsideSummary.exchange, 1); assert.equal(detail.outsideOrders[0].state, 'exchange');
  assert.equal(h.calls.lookup.length, 0, '맞교환의 주문번호로 원판매 등록 여부를 조회하지 않습니다.');
  assert.equal((await h.day(originalBatch))[0].state, 'complete', '맞교환 날짜만 처리한 새 차수는 원판매 완료를 무효화하지 않습니다.');
  assert.deepEqual(await h.bytes(initial.run.id, 'download'), bytes);
  assert.deepEqual(h.db.prepare('SELECT * FROM rows WHERE id=?').get(originalBatch.rows[0].id), savedRow);
});

test('같은 주문의 맞교환 출고는 최종 네이버 원본 매칭과 엑셀에 섞지 않는다', async t => {
  const original = sale(), separate = { ...exchange(original), internalId: 'EXCHANGE-1', trackingNumber: '990005999999' }, h = await boot(t, [original]);
  const added = await h.add([original, separate], '2026-11-05'), detail = await h.match([original], [original, separate]);
  assert.equal(detail.items.length, 1); assert.equal(detail.items[0].decision, 'include');
  assert.deepEqual(detail.items[0].sourceRows.map(row => row.rowId), [added.rows[0].id]);
  assert.equal(detail.items[0].trackingNumber, original.trackingNumber); assert.equal(detail.outsideSummary.exchange, 1);
  const workbook = XLSX.read(await h.bytes(detail.run.id), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['발송처리'], { header: 1 });
  assert.equal(rows.length, 2); assert.equal(rows[1][3], original.trackingNumber);
  await h.check(detail); assert.deepEqual(h.calls.details.flat(), [original.productOrderId]);
  assert.equal((await h.day(added))[1].state, 'exchange');
});

test('맞교환 날짜 전체를 원판매의 관련 날짜로 가져오거나 그날 다른 주문을 조회하지 않는다', async t => {
  const original = sale(), unrelated = sale(2), h = await boot(t, [original, unrelated]);
  await h.add([original], '2026-11-05'); await h.add([exchange(original), unrelated], '2026-11-07');
  const detail = await h.match([original], [original]);
  assert.equal(detail.outsideOrders.length, 0); assert.deepEqual(h.calls.lookup, []);
});

test('c057·9843 저장 근거에 이미 맞교환이 포함되어도 형식 분리만으로 원판매 완료를 보류하지 않는다', async t => {
  for (const version of ['c057', '9843']) await t.test(version, async t => {
    const original = sale(), h = await boot(t, [original]);
    await h.add([original], '2026-11-05'); await h.add([exchange(original)], '2026-11-05');
    const detail = await h.match([original], [original]); await h.check(detail);
    persistOldContract(h, detail.run.id, version);
    await h.add([{ ...exchange(original), productName: '[맞교환] 추가 별도 출고', phone: '050-0000-0003' }], '2026-11-07');
    const after = await h.read(`/api/invoices/${detail.run.id}`);
    assert.equal(after.items[0].registrationState, 'complete'); assert.equal(after.items[0].statusFresh, true);
    assert.ok(!after.issues.some(issue => issue.kind === 'source_changed'));
    assert.ok(after.orders.some(row => row.state === 'exchange'));
  });
});

test('옛 outside 조회 근거도 맞교환과 분리하고 새 맞교환의 과거 proof는 원판매 완료를 덮지 않는다', async t => {
  for (const version of ['c057', '9843']) await t.test(version, async t => {
    const original = sale(), current = sale(2), later = sale(3), h = await boot(t, [original, current, later]);
    const originalBatch = await h.add([original, current, exchange(original)], '2026-11-05');
    const detail = await h.match([current], [current]); persistOldContract(h, detail.run.id, version);
    await h.add([exchange(original), later], '2026-11-07');
    const newer = await h.match([later], [later], '2026-11-07');
    const scope = JSON.parse(h.db.prepare('SELECT scope_json FROM invoice_runs WHERE id=?').get(newer.run.id).scope_json);
    scope.outsideOrders = [{ rowId: h.facts[3].rowId, orderId: original.orderId, state: 'unknown', checkedAt: newer.run.createdAt }];
    h.db.prepare('UPDATE invoice_runs SET scope_json=? WHERE id=?').run(JSON.stringify(scope), newer.run.id);
    const after = await h.read(`/api/invoices/${detail.run.id}`);
    assert.equal(after.outsideOrders.find(row => row.rowId === originalBatch.rows[0].id).state, 'external_registered');
    assert.equal((await h.day(originalBatch))[0].state, 'external_registered');
    const copied = h.facts[3];
    assert.equal((await h.request(`/api/batches/${copied.batchId}/rows`, json('DELETE', { rowIds: [copied.rowId] }))).status, 200);
    assert.equal((await h.day(originalBatch))[0].state, 'external_registered', '삭제된 교환의 과거 proof도 원판매의 최신 조회로 해석하지 않습니다.');
  });
});

test('과거 상품주문 source_rows에 맞교환이 잘못 들어갔으면 조회와 새 엑셀을 막고 저장본은 보존한다', async t => {
  const original = sale(), h = await boot(t, [original]); await h.add([original, exchange(original)], '2026-11-05');
  const detail = await h.match([original], [original]), bytes = await h.bytes(detail.run.id); await h.check(detail);
  const record = h.db.prepare('SELECT * FROM invoice_items WHERE id=?').get(detail.items[0].id), sources = JSON.parse(record.source_rows_json);
  sources.push(h.facts[1].source);
  h.db.prepare('UPDATE invoice_items SET source_rows_json=? WHERE id=?').run(JSON.stringify(sources), record.id);
  const after = await h.read(`/api/invoices/${detail.run.id}`);
  assert.ok(after.issues.some(issue => issue.kind === 'exchange_source' && issue.blocking));
  assert.equal(after.items[0].registrationState, 'unchecked');
  const beforeCalls = h.calls.details.length;
  assert.equal((await h.request(`/api/invoices/${detail.run.id}/check`, { method: 'POST' })).status, 400);
  assert.equal(h.calls.details.length, beforeCalls);
  assert.equal((await h.request(`/api/invoices/${detail.run.id}/download?rebuild=1`)).status, 400);
  assert.deepEqual(await h.bytes(detail.run.id, 'download'), bytes);
});

test('맞교환도 같은 내부 출고번호를 재사용하면 충돌이며 일반 주문 변경과 원본 삭제 보호를 유지한다', async t => {
  for (const change of ['same_internal', 'ordinary_order', 'delete']) await t.test(change, async t => {
    const original = sale(), h = await boot(t, [original]);
    const added = await h.add([original], '2026-11-05'), detail = await h.match([original], [original]); await h.check(detail);
    if (change === 'delete') assert.equal((await h.request(`/api/batches/${added.batch.id}/rows`, json('DELETE', { rowIds: [added.rows[0].id] }))).status, 200);
    else await h.add([change === 'same_internal' ? { ...exchange(original), internalId: original.internalId, cleanedName: original.productName }
      : { ...exchange(original), productName: '가상 맞교환 상품', internalId: 'ORDINARY-1' }], '2026-11-07');
    const after = await h.read(`/api/invoices/${detail.run.id}`);
    assert.equal(after.items[0].registrationState, 'unchecked'); assert.equal(after.items[0].statusFresh, false);
    assert.ok(after.issues.some(issue => issue.kind === 'source_changed'));
    if (change === 'same_internal') assert.ok(after.issues.some(issue => issue.kind === 'legacy_conflict'));
  });
});

test('동일 내부 출고번호의 판매·맞교환 충돌은 송장 선택과 경고 확인으로 강제 포함할 수 없다', async t => {
  const original = sale(), separate = { ...exchange(original), internalId: original.internalId, cleanedName: original.productName }, h = await boot(t, [original]);
  await h.add([original, separate], '2026-11-05');
  const second = { ...original, trackingNumber: '990005999999', round: 2 }, detail = await h.match([original], [{ ...original, round: 1 }, second]);
  assert.ok(detail.issues.some(issue => issue.kind === 'legacy_conflict' && issue.blocking));
  const response = await h.request(`/api/invoices/${detail.run.id}/items`, json('PATCH', {
    issueResolutions: detail.issues.filter(issue => issue.reviewRequired !== false).map(issue => ({ key: issue.key })),
    changes: [{ id: detail.items[0].id, decision: 'include', note: '가상 송장 선택', selectedTrackingNumber: second.trackingNumber }],
  }));
  assert.equal(response.status, 400);
  assert.equal((await h.request(`/api/invoices/${detail.run.id}/export`)).status, 400);
});
