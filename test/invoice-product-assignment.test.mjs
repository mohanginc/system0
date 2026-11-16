import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { importFiles } from '../lib/excel.mjs';
import { sourceFile, sourceHeaders, workbookFile, naverFile, courierFile, registeredOrder } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `absent-${randomUUID()}.env`);
process.env.DISCORD_ENV_FILE = path.join(os.tmpdir(), `absent-${randomUUID()}.env`);
const { createApp } = await import('../server.mjs');
const date = '2026-11-16', orderId = '2026111471898391';
const sharedTitle = '면100수 누빔 새싹 High(쿠션높이 13cm)-[높이선택]듀얼사이드/고밀도 모션폼/직수를 하는 엄마를 위한 완전밀착 D타입 높은 수유쿠션';
const common = { orderId, recipient: '김은영', phone: '010-0000-0000', address: '서울 검증로 1 101호', quantity: 1,
  round: 1, issueCount: 1, printedAt: '12:50:57' };
const high = { ...common, productOrderId: '2026111445809241', internalId: '202611141153180008', trackingNumber: '45585414265',
  productName: '완전밀착 새싹(면100수) D타입 High(13cm)',
  optionName: '제품선택: 면100수 누빔 새싹 / 높이: High(쿠션높이 13cm)' };
const superHigh = { ...common, productOrderId: '2026111445809251', internalId: '202611141153180007', trackingNumber: '45585414276',
  productName: '완전밀착 새싹(면100수) D타입 Super High(15cm)',
  optionName: '제품선택: 면100수 누빔 새싹 / 높이: Super High(쿠션높이 15cm)' };
const naverProducts = [superHigh, high].map(order => ({ ...order, productName: sharedTitle }));
const jsonOptions = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const itemFor = (view, product) => view.items.find(item => item.productOrderId === product.productOrderId);
const groupFor = (view, product) => view.trackingReview.groups.find(group => group.kind === 'assignment'
  && group.productOrderIds.includes(product.productOrderId));
const choiceFor = (view, product) => ({ key: groupFor(view, product)?.key, trackingNumber: product.trackingNumber, mode: 'assign' });
const excelRows = bytes => {
  const book = XLSX.read(bytes, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(book.Sheets['발송처리'], { header: 1, raw: true });
};

async function setup(t, { sameInternal = false, naver, fileBacked = false } = {}) {
  let outsideCalls = 0;
  const temporary = fileBacked ? mkdtempSync(path.join(os.tmpdir(), 'system0-assignment-test-')) : null;
  const options = { databasePath: temporary ? path.join(temporary, 'test.sqlite') : ':memory:', apiKey: '', client: null, discordConfig: null,
    naver: naver || { queryProductOrders: async () => { outsideCalls++; throw new Error('실제 네이버 API 호출 금지'); } } };
  let app = createApp(options), db = app.locals.db, server, base;
  const listen = async () => {
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); db.close(); };
  await listen();
  t.after(async () => { await stop(); if (temporary) rmSync(temporary, { recursive: true, force: true }); });
  const restart = async () => { assert.ok(temporary, '재시작은 격리된 파일 DB에서만 검증합니다.'); await stop(); app = createApp(options); db = app.locals.db; await listen(); };
  const sourceOrders = sameInternal ? [high] : [high, superHigh];
  const source = sameInternal ? sourceFile(sourceOrders) : workbookFile('rus00 - 2026-11-14T124338.164.xls.xlsx', sourceHeaders,
    [...Array.from({ length: 20 }, () => []), ...sourceOrders.map(order => [order.productName, order.internalId, order.orderId,
      order.recipient, order.phone, order.address, order.quantity, '네이버'])]);
  const batch = importFiles(db, [{ ...source, originalname: source.name }]);
  db.prepare('UPDATE batches SET created_at=? WHERE id=?').run('2026-11-14T03:43:38.164Z', batch.batch.id);
  const naming = await fetch(base + `/api/batches/${batch.batch.id}/rows`, { ...jsonOptions({ changes: batch.rows.map((row, index) => ({
    id: row.id, cleanedName: sourceOrders[index].productName, status: 'confirmed', reviewNote: '' })) }), method: 'PATCH' });
  assert.equal(naming.status, 200, await naming.text());
  const sourceSnapshot = () => JSON.stringify(Object.fromEntries(['batches', 'sheets', 'source_files', 'rows', 'row_revisions']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
  const savedSource = sourceSnapshot();
  const start = async (parcels = sourceOrders, products = naverProducts, suffix = '') => {
    const form = new FormData(), naver = naverFile(products, `네이버${suffix}.xlsx`), courier = courierFile(parcels, `로젠${suffix}.xlsx`);
    form.append('naverFiles', new Blob([naver.buffer]), naver.name);
    form.append('courierFiles', new Blob([courier.buffer]), courier.name);
    form.append('deliveryCompanyCode', 'KGB'); form.append('sourceDate', date);
    const response = await fetch(base + '/api/invoices/import', { method: 'POST', body: form });
    const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body)); return body;
  };
  const view = async id => {
    const response = await fetch(base + `/api/invoices/${id}`);
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const select = async (before, choices) => {
    const response = await fetch(base + `/api/invoices/${before.run.id}/tracking`, jsonOptions({ expectedVersion: before.viewVersion, choices }));
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const build = async before => {
    const response = await fetch(base + `/api/invoices/${before.run.id}/file`, jsonOptions({ mode: 'auto', expectedVersion: before.viewVersion }));
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(response.status, 200, bytes.toString('utf8')); return bytes;
  };
  const assertSourceUntouched = () => { assert.equal(sourceSnapshot(), savedSource); assert.equal(outsideCalls, 0); };
  return { get db() { return db; }, get base() { return base; }, start, view, select, build, assertSourceUntouched, batch, restart };
}

function assertAssigned(view, product, rowId) {
  const item = itemFor(view, product);
  assert.equal(item.internalId, product.internalId);
  assert.equal(item.trackingNumber, product.trackingNumber);
  assert.equal(item.decision, 'include');
  assert.equal(item.cleanedName, product.productName);
  assert.deepEqual(item.sourceRows.map(source => source.rowId), [rowId]);
  assert.ok(item.physicalShipments.length > 0);
  assert.ok(item.physicalShipments.every(parcel => parcel.internalId === product.internalId));
  assert.ok(!item.issues.some(key => view.issues.some(issue => issue.key === key && issue.blocking)));
}

test('김은영 13·15cm는 상품주문별로 선택하고 부분 저장·재조회한 뒤 서로 다른 송장으로 엑셀을 만든다', async t => {
  const s = await setup(t), initial = await s.start();
  const highGroup = groupFor(initial, high), superGroup = groupFor(initial, superHigh);
  assert.ok(highGroup && superGroup, '같은 주문번호여도 별도 출고 상품마다 송장 선택 묶음이 필요합니다.');
  assert.notEqual(highGroup.key, superGroup.key);
  for (const [group, product] of [[highGroup, high], [superGroup, superHigh]]) {
    assert.equal(group.assignEligible, true);
    assert.deepEqual(group.itemIds, [itemFor(initial, product).id]);
    assert.equal(group.needsSelection, true);
    assert.deepEqual(group.candidates.map(parcel => [parcel.internalId, parcel.trackingNumber]).sort(),
      [high, superHigh].map(order => [order.internalId, order.trackingNumber]).sort());
  }
  assert.equal(initial.trackingReview.pendingCount, 2);
  assert.ok(initial.items.every(item => !item.registrationRecheck));
  assert.equal(initial.currentOrders.length, 2);
  for (const product of [high, superHigh]) {
    const row = initial.currentOrders.find(order => order.itemIds.includes(itemFor(initial, product).id));
    assert.deepEqual(row.itemIds, [itemFor(initial, product).id]);
    assert.equal(row.cleanedName, product.optionName, '원문 공통 제목보다 실제 선택한 높이를 표시합니다.');
    assert.equal(row.sourceType, 'saved_product');
    assert.equal(row.batchId, s.batch.batch.id);
    assert.equal(row.source.batchCreatedAt.slice(0, 10), '2026-11-14');
    assert.equal(row.rowId, null, '표시할 작업 묶음 때문에 상품주문 선택을 원본행 단위로 합치지 않습니다.');
    assert.equal(row.source.sourceRow, undefined, '선택 전에는 후보 원본 중 특정 행으로 연결됐다고 표시하지 않습니다.');
  }
  const beforeSibling = JSON.stringify(itemFor(initial, superHigh));
  const partial = await s.select(initial, [choiceFor(initial, high)]);
  assertAssigned(partial, high, s.batch.rows[0].id);
  assert.equal(JSON.stringify(itemFor(partial, superHigh)), beforeSibling, '13cm 저장이 15cm 선택·판정을 바꾸면 안 됩니다.');
  assert.equal(partial.trackingReview.pendingCount, 1);
  const blocked = await fetch(s.base + `/api/invoices/${initial.run.id}/file`, jsonOptions({ mode: 'auto', expectedVersion: partial.viewVersion }));
  assert.equal(blocked.status, 400, '한 상품이 미선택이면 엑셀 생성을 막습니다.');
  const refreshed = await s.view(initial.run.id);
  assertAssigned(refreshed, high, s.batch.rows[0].id);
  const complete = await s.select(refreshed, [choiceFor(refreshed, superHigh)]);
  assert.ok(complete.items.every(item => !item.registrationRecheck), '처음 미등록 송장 선택에 등록 재조회를 강제하지 않습니다.');
  assert.equal(complete.trackingReview.pendingCount, 0);
  assertAssigned(complete, high, s.batch.rows[0].id);
  assertAssigned(complete, superHigh, s.batch.rows[1].id);
  assert.deepEqual(complete.currentOrders.map(row => row.source.sourceRow), [22, 23], '연결 후에는 원래 작업의 원본행 순서로 표시합니다.');
  for (const product of [high, superHigh]) {
    const row = complete.currentOrders.find(order => order.itemIds.includes(itemFor(complete, product).id));
    assert.equal(row.sourceType, 'saved_product'); assert.equal(row.batchId, s.batch.batch.id);
    assert.deepEqual(row.latestStatus.productOrderIds, [product.productOrderId]);
    assert.deepEqual(row.trackingNumbers, [product.trackingNumber]);
    assert.equal(row.source.rowId, itemFor(complete, product).sourceRows[0].rowId);
  }
  assert.deepEqual(excelRows(await s.build(complete)), [['상품주문번호', '배송방법', '택배사', '송장번호'],
    ...[superHigh, high].map(order => [order.productOrderId, '택배,등기,소포', '로젠택배', order.trackingNumber])]);
  const persisted = await s.view(initial.run.id);
  assertAssigned(persisted, high, s.batch.rows[0].id); assertAssigned(persisted, superHigh, s.batch.rows[1].id);
  s.assertSourceUntouched();
});

test('상품별 출고 연결은 재업로드에도 유지하고 한 출고의 재출력 선택이 다른 상자 송장을 폐기하지 않는다', async t => {
  const s = await setup(t), initial = await s.start();
  const assigned = await s.select(initial, [choiceFor(initial, high), choiceFor(initial, superHigh)]);
  const savedBytes = await s.build(assigned);
  const renamedNaver = naverProducts.map(order => ({ ...order, productName: sharedTitle + ' (재다운로드)' }));
  const reuploaded = await s.start([high, superHigh], renamedNaver, '재업로드');
  assert.notEqual(reuploaded.run.id, initial.run.id);
  assertAssigned(reuploaded, high, s.batch.rows[0].id); assertAssigned(reuploaded, superHigh, s.batch.rows[1].id);
  assert.equal(reuploaded.trackingReview.pendingCount, 0);
  const replacement = { ...high, trackingNumber: '45585414999', round: 2, printedAt: '15:00:00' };
  const reprint = await s.start([replacement, superHigh], renamedNaver, '13cm재출력');
  assert.equal(itemFor(reprint, high).internalId, high.internalId);
  assert.equal(itemFor(reprint, superHigh).trackingNumber, superHigh.trackingNumber);
  const group = reprint.trackingReview.groups.find(group => group.itemIds.includes(itemFor(reprint, high).id));
  assert.ok(group && group.kind !== 'assignment');
  assert.deepEqual(group.itemIds, [itemFor(reprint, high).id]);
  assert.equal(group.replacementEligible, true);
  const done = await s.select(reprint, [{ key: group.key, trackingNumber: replacement.trackingNumber, mode: 'replace' }]);
  assert.equal(itemFor(done, high).trackingNumber, replacement.trackingNumber);
  assert.equal(itemFor(done, high).physicalShipments.find(parcel => parcel.trackingNumber === high.trackingNumber).valid, false);
  assertAssigned(done, superHigh, s.batch.rows[1].id);
  assert.equal(itemFor(done, superHigh).physicalShipments.find(parcel => parcel.trackingNumber === superHigh.trackingNumber).valid, true);
  assert.deepEqual(excelRows(await s.build(done)).slice(1).map(row => [row[0], row[3]]),
    [[superHigh.productOrderId, superHigh.trackingNumber], [high.productOrderId, replacement.trackingNumber]]);
  const saved = await fetch(s.base + `/api/invoices/${initial.run.id}/download`);
  assert.equal(saved.status, 200); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), savedBytes);
  s.assertSourceUntouched();
});

test('같은 내부 출고에 연결된 두 상품은 재출력 대표 송장을 함께 선택하는 동작을 유지한다', async t => {
  const s = await setup(t, { sameInternal: true });
  await s.start([high]);
  const replacement = { ...high, trackingNumber: '45585414998', round: 2, printedAt: '15:00:00' };
  const initial = await s.start([replacement], naverProducts, '한상자재출력');
  const group = initial.trackingReview.groups[0];
  assert.ok(group.kind !== 'assignment');
  assert.equal(initial.trackingReview.groups.length, 1);
  assert.deepEqual(group.itemIds.sort(), initial.items.map(item => item.id).sort());
  const done = await s.select(initial, [{ key: group.key, trackingNumber: replacement.trackingNumber, mode: 'replace' }]);
  assert.ok(done.items.every(item => item.trackingNumber === replacement.trackingNumber && item.internalId === high.internalId));
  assert.ok(done.items.every(item => item.physicalShipments.find(parcel => parcel.trackingNumber === high.trackingNumber).valid === false));
  assert.deepEqual(excelRows(await s.build(done)).slice(1).map(row => row[3]), [replacement.trackingNumber, replacement.trackingNumber]);
  s.assertSourceUntouched();
});

test('상품별 출고 선택의 중복 키·외부 송장·없는 묶음·오래된 버전 요청은 일부도 저장하지 않는다', async t => {
  const s = await setup(t), initial = await s.start();
  assert.ok(groupFor(initial, high) && groupFor(initial, superHigh));
  const snapshot = () => JSON.stringify(Object.fromEntries(['invoice_items', 'invoice_revisions', 'invoice_runs', 'invoice_files']
    .map(table => [table, s.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])));
  const before = snapshot(), valid = choiceFor(initial, high);
  for (const choices of [[valid, valid], [valid, { ...choiceFor(initial, superHigh), trackingNumber: '99999999999' }],
    [valid, { ...choiceFor(initial, superHigh), key: 'foreign-group' }]]) {
    const response = await fetch(s.base + `/api/invoices/${initial.run.id}/tracking`, jsonOptions({ expectedVersion: initial.viewVersion, choices }));
    assert.equal(response.status, 400, await response.text()); assert.equal(snapshot(), before);
  }
  const partial = await s.select(initial, [valid]), afterPartial = snapshot();
  const stale = await fetch(s.base + `/api/invoices/${initial.run.id}/tracking`, jsonOptions({ expectedVersion: initial.viewVersion,
    choices: [choiceFor(partial, superHigh)] }));
  assert.equal(stale.status, 409); assert.equal(snapshot(), afterPartial);
  s.assertSourceUntouched();
});

test('선택 근거인 정리된 제품명이 바뀌면 과거 연결로 엑셀을 만들거나 송장을 재선택할 수 없다', async t => {
  const s = await setup(t), initial = await s.start();
  const assigned = await s.select(initial, [choiceFor(initial, high), choiceFor(initial, superHigh)]);
  const change = await fetch(s.base + `/api/batches/${s.batch.batch.id}/rows`, { ...jsonOptions({ changes: [{ id: s.batch.rows[0].id,
    cleanedName: high.productName + ' 변경', status: 'confirmed', reviewNote: '검증용 근거 변경' }] }), method: 'PATCH' });
  assert.equal(change.status, 200, await change.text());
  const invalidated = await s.view(assigned.run.id), item = itemFor(invalidated, high), group = groupFor(invalidated, high);
  assert.equal(item.assignmentValid, false);
  assert.ok(invalidated.issues.some(issue => item.issues.includes(issue.key) && issue.kind === 'source_changed' && issue.blocking));
  assert.equal(group.assignEligible, false);
  const before = JSON.stringify(s.db.prepare('SELECT * FROM invoice_items ORDER BY id').all());
  const selection = await fetch(s.base + `/api/invoices/${initial.run.id}/tracking`, jsonOptions({ expectedVersion: invalidated.viewVersion,
    choices: [choiceFor(invalidated, high)] }));
  assert.equal(selection.status, 400, await selection.text());
  const file = await fetch(s.base + `/api/invoices/${initial.run.id}/file`, jsonOptions({ mode: 'auto', expectedVersion: invalidated.viewVersion }));
  assert.equal(file.status, 400, await file.text());
  assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM invoice_items ORDER BY id').all()), before);
});

test('수취 정보가 다른 송장은 거절하고 네이버 등록 여부와 로컬 송장 정정을 구분한다', async t => {
  await t.test('수취 주소가 다른 송장', async t => {
    const s = await setup(t), initial = await s.start([{ ...high, address: '서울 다른로 99 202호' }, superHigh]);
    const group = groupFor(initial, high);
    assert.equal(group.candidates.find(parcel => parcel.trackingNumber === high.trackingNumber).selectable, false);
    const before = JSON.stringify(s.db.prepare('SELECT * FROM invoice_items ORDER BY id').all());
    const response = await fetch(s.base + `/api/invoices/${initial.run.id}/tracking`, jsonOptions({ expectedVersion: initial.viewVersion,
      choices: [choiceFor(initial, high)] }));
    assert.equal(response.status, 400, await response.text());
    assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM invoice_items ORDER BY id').all()), before);
    s.assertSourceUntouched();
  });
  await t.test('배송중 원본의 로컬 송장을 정정하고 최신 조회로 이전 원본의 송장 차이를 해소한다', async t => {
    const byId = new Map([high, superHigh].map(order => [order.productOrderId, order]));
    const s = await setup(t, { naver: { queryProductOrders: async ids => ids.map(id => registeredOrder(byId.get(id))) } });
    const products = naverProducts.map(order => ({ ...order, status: '배송중', sourceTrackingNumber: superHigh.trackingNumber, carrier: '로젠택배' }));
    const initial = await s.start([high, superHigh], products);
    const assigned = await s.select(initial, [choiceFor(initial, high), choiceFor(initial, superHigh)]);
    assert.ok(assigned.items.every(item => item.registrationRecheck && item.naverRegistration === null));
    const blocked = await fetch(s.base + `/api/invoices/${assigned.run.id}/export`);
    assert.equal(blocked.status, 400, await blocked.text());
    const response = await fetch(s.base + `/api/invoices/${assigned.run.id}/check`, { method: 'POST' });
    const checked = await response.json(); assert.equal(response.status, 200, JSON.stringify(checked));
    for (const product of [high, superHigh]) {
      const item = itemFor(checked, product);
      assert.equal(item.trackingNumber, product.trackingNumber);
      assert.equal(item.registrationState, 'complete');
      assert.equal(item.naverRegistration.matches, true);
      assert.deepEqual(item.blockingIssueKeys, [], '최신 API가 확인한 송장을 과거 원본의 송장 차이로 계속 막으면 안 됩니다.');
    }
    assert.equal(checked.fileActions.reviewRequired, false);
    s.assertSourceUntouched();
  });
});

test('각 상품의 실제 등록 송장을 조회하고 토요일 화면에도 해당 상품의 월요일 처리 상태만 표시한다', async t => {
  const queried = [], byId = new Map([high, superHigh].map(order => [order.productOrderId, order]));
  const naver = { queryProductOrders: async ids => { queried.push([...ids]); return ids.map(id => registeredOrder(byId.get(id))); } };
  const s = await setup(t, { naver }), initial = await s.start();
  assert.ok(initial.items.every(item => item.naverRegistration === null));
  const assigned = await s.select(initial, [choiceFor(initial, high), choiceFor(initial, superHigh)]);
  const sourceView = async () => {
    const response = await fetch(s.base + '/api/invoices/orders?batchIds=' + encodeURIComponent(JSON.stringify([s.batch.batch.id])));
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const assertProjection = (view, state) => {
    assert.equal(view.currentOrders.length, 2);
    assert.ok(view.checkRunIds.includes(initial.run.id));
    for (const [product, row] of [[high, s.batch.rows[0]], [superHigh, s.batch.rows[1]]]) {
      const projected = view.currentOrders.find(order => order.rowId === row.id);
      assert.equal(projected.state, state);
      assert.deepEqual(projected.latestStatus.productOrderIds, [product.productOrderId]);
      assert.deepEqual(projected.trackingNumbers, [product.trackingNumber]);
      assert.equal(projected.latestStatus.processingDate, date);
      assert.equal(projected.latestStatus.readonly, true);
      const details = projected.latestStatus.products;
      assert.equal(details.length, 1);
      assert.equal(details[0].appliedTrackingNumber, product.trackingNumber);
      assert.equal(details[0].naverRegistration?.matches ?? null, state === 'complete' ? true : null);
      if (state === 'complete') {
        assert.equal(details[0].naverRegistration.trackingNumber, product.trackingNumber);
        assert.equal(details[0].naverRegistration.fresh, true);
      }
    }
  };
  assertProjection(await sourceView(), 'ready');
  const response = await fetch(s.base + `/api/invoices/${assigned.run.id}/check`, { method: 'POST' });
  const checked = await response.json(); assert.equal(response.status, 200, JSON.stringify(checked));
  assert.deepEqual(queried.flat().sort(), [high.productOrderId, superHigh.productOrderId].sort());
  for (const product of [high, superHigh]) {
    assert.equal(itemFor(checked, product).registrationState, 'complete');
    assert.equal(itemFor(checked, product).statusFresh, true);
    assert.equal(itemFor(checked, product).trackingNumber, product.trackingNumber);
    assert.deepEqual(itemFor(checked, product).registrationProblems, []);
    assert.deepEqual(itemFor(checked, product).naverRegistration, { trackingNumber: product.trackingNumber, carrierCode: 'KGB',
      status: 'DELIVERING', checkedAt: itemFor(checked, product).checkedAt, fresh: true, matches: true });
    assert.ok(Number.isFinite(Date.parse(itemFor(checked, product).naverRegistration.checkedAt)));
  }
  assertProjection(await sourceView(), 'complete');
  s.assertSourceUntouched();
});

test('system0에서 반대로 선택한 두 송장을 네이버 조회와 비교하고 충돌 원문과 직원 선택을 보존한다', async t => {
  const byId = new Map([high, superHigh].map(order => [order.productOrderId, order]));
  const s = await setup(t, { naver: { queryProductOrders: async ids => ids.map(id => registeredOrder(byId.get(id))) } });
  const initial = await s.start(), applied = new Map([[high.productOrderId, superHigh.trackingNumber], [superHigh.productOrderId, high.trackingNumber]]);
  const wrong = await s.select(initial, [
    { ...choiceFor(initial, high), trackingNumber: superHigh.trackingNumber },
    { ...choiceFor(initial, superHigh), trackingNumber: high.trackingNumber },
  ]);
  const response = await fetch(s.base + `/api/invoices/${wrong.run.id}/check`, { method: 'POST' });
  const checked = await response.json(); assert.equal(response.status, 200, JSON.stringify(checked));
  for (const product of [high, superHigh]) {
    const item = itemFor(checked, product);
    assert.equal(item.trackingNumber, applied.get(product.productOrderId), '조회는 직원이 선택한 적용 송장을 바꾸면 안 됩니다.');
    assert.equal(item.registrationState, 'conflict');
    assert.ok(item.registrationProblems.includes('tracking_conflict'));
    assert.deepEqual(item.naverRegistration, { trackingNumber: product.trackingNumber, carrierCode: 'KGB', status: 'DELIVERING',
      checkedAt: item.checkedAt, fresh: true, matches: false });
  }
  const sourceResponse = await fetch(s.base + '/api/invoices/orders?batchIds=' + encodeURIComponent(JSON.stringify([s.batch.batch.id])));
  const source = await sourceResponse.json(); assert.equal(sourceResponse.status, 200, JSON.stringify(source));
  const products = source.currentOrders.flatMap(order => order.latestStatus.products);
  assert.equal(products.length, 2);
  for (const product of [high, superHigh]) {
    const projected = products.find(row => row.productOrderId === product.productOrderId);
    assert.equal(projected.appliedTrackingNumber, applied.get(product.productOrderId));
    assert.deepEqual(projected.naverRegistration, itemFor(checked, product).naverRegistration);
  }
  s.assertSourceUntouched();
});

test('네이버 조회 후에도 김은영의 완료·충돌 두 상품을 각각 정정하고 재조회 전까지 과거 관측과 엑셀을 보존한다', async t => {
  const byId = new Map([high, superHigh].map(order => [order.productOrderId, order]));
  const s = await setup(t, { naver: { queryProductOrders: async ids => ids.map(id => registeredOrder(byId.get(id), { trackingNumber: superHigh.trackingNumber })) } });
  const initial = await s.start();
  const wrong = await s.select(initial, [{ ...choiceFor(initial, high), trackingNumber: superHigh.trackingNumber },
    { ...choiceFor(initial, superHigh), trackingNumber: high.trackingNumber }]);
  const originalFile = await s.build(wrong);
  const response = await fetch(s.base + `/api/invoices/${wrong.run.id}/check`, { method: 'POST' });
  const observed = await response.json(); assert.equal(response.status, 200, JSON.stringify(observed));
  assert.equal(itemFor(observed, high).registrationState, 'complete');
  assert.equal(itemFor(observed, superHigh).registrationState, 'conflict');
  const siblingBefore = JSON.stringify(itemFor(observed, high));
  const firstCorrection = await s.select(observed, [choiceFor(observed, superHigh)]);
  assert.equal(itemFor(firstCorrection, superHigh).trackingNumber, superHigh.trackingNumber);
  assert.equal(JSON.stringify(itemFor(firstCorrection, high)), siblingBefore, '15cm 정정이 이미 등록 확인된 13cm를 바꾸면 안 됩니다.');
  const corrected = await s.select(firstCorrection, [choiceFor(firstCorrection, high)]);
  for (const product of [high, superHigh]) {
    const item = itemFor(corrected, product);
    assert.equal(item.trackingNumber, product.trackingNumber);
    assert.equal(item.registrationRecheck, true);
    assert.equal(item.statusFresh, false);
    assert.notEqual(item.registrationState, 'complete', '직원 정정만으로 네이버 등록 완료를 추정하지 않습니다.');
    assert.deepEqual(item.naverRegistration, { ...itemFor(observed, product).naverRegistration, fresh: false, matches: null });
  }
  const blocked = await fetch(s.base + `/api/invoices/${corrected.run.id}/export`);
  assert.equal(blocked.status, 400, await blocked.text());
  const saved = await fetch(s.base + `/api/invoices/${corrected.run.id}/download`);
  assert.equal(saved.status, 200); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), originalFile);
  const recheckedResponse = await fetch(s.base + `/api/invoices/${corrected.run.id}/check`, { method: 'POST' });
  const rechecked = await recheckedResponse.json(); assert.equal(recheckedResponse.status, 200, JSON.stringify(rechecked));
  assert.equal(itemFor(rechecked, superHigh).registrationState, 'complete');
  assert.equal(itemFor(rechecked, superHigh).naverRegistration.matches, true);
  assert.equal(itemFor(rechecked, high).registrationState, 'conflict');
  assert.equal(itemFor(rechecked, high).naverRegistration.matches, false);
  assert.ok(itemFor(rechecked, high).registrationProblems.includes('tracking_conflict'));
  assert.equal(itemFor(rechecked, high).trackingNumber, high.trackingNumber);
  const after = await fetch(s.base + `/api/invoices/${corrected.run.id}/download`);
  assert.deepEqual(Buffer.from(await after.arrayBuffer()), originalFile);
  s.assertSourceUntouched();
});

test('네이버 조회의 주소·수량·취소 불일치는 로컬 송장 정정으로 우회할 수 없다', async t => {
  for (const [problem, changes] of [['recipient_changed', { address: '서울 다른로 99', detailAddress: '202호' }],
    ['quantity_changed', { remainQuantity: 2 }], ['claim', { status: 'CANCELED', remainQuantity: 0 }]]) {
    await t.test(problem, async t => {
      const byId = new Map([high, superHigh].map(order => [order.productOrderId, order]));
      const s = await setup(t, { naver: { queryProductOrders: async ids => ids.map(id => registeredOrder(byId.get(id), id === high.productOrderId ? changes : {})) } });
      const initial = await s.start(), assigned = await s.select(initial, [choiceFor(initial, high), choiceFor(initial, superHigh)]);
      const response = await fetch(s.base + `/api/invoices/${assigned.run.id}/check`, { method: 'POST' });
      const checked = await response.json(); assert.equal(response.status, 200, JSON.stringify(checked));
      assert.ok(itemFor(checked, high).registrationProblems.includes(problem));
      assert.equal(groupFor(checked, high).assignEligible, false);
      const before = JSON.stringify(s.db.prepare('SELECT * FROM invoice_items ORDER BY id').all());
      const rejected = await fetch(s.base + `/api/invoices/${assigned.run.id}/tracking`, jsonOptions({ expectedVersion: checked.viewVersion,
        choices: [{ ...choiceFor(checked, high), trackingNumber: superHigh.trackingNumber }] }));
      assert.equal(rejected.status, 400, await rejected.text());
      assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM invoice_items ORDER BY id').all()), before);
      s.assertSourceUntouched();
    });
  }
});

test('미등록 응답은 일치로 표시하지 않고 조회 실패·근거 변경 뒤의 과거 네이버 송장은 최신으로 표시하지 않는다', async t => {
  const byId = new Map([high, superHigh].map(order => [order.productOrderId, order]));
  let mode = 'pending';
  const s = await setup(t, { naver: { queryProductOrders: async ids => {
    if (mode === 'failure') throw new Error('검증용 조회 실패');
    return ids.map(id => registeredOrder(byId.get(id), mode === 'pending'
      ? { status: 'PAYED', deliveryStatus: '', trackingNumber: '', deliveryCompanyCode: '' } : {}));
  } } });
  const initial = await s.start(), assigned = await s.select(initial, [choiceFor(initial, high), choiceFor(initial, superHigh)]);
  const check = () => fetch(s.base + `/api/invoices/${assigned.run.id}/check`, { method: 'POST' });
  const pendingResponse = await check(), pending = await pendingResponse.json(); assert.equal(pendingResponse.status, 200, JSON.stringify(pending));
  for (const item of pending.items) {
    assert.equal(item.registrationState, 'pending');
    assert.deepEqual(item.naverRegistration, { trackingNumber: '', carrierCode: '', status: 'PAYED', checkedAt: item.checkedAt, fresh: true, matches: null });
  }
  mode = 'registered';
  const registeredResponse = await check(), registered = await registeredResponse.json(); assert.equal(registeredResponse.status, 200, JSON.stringify(registered));
  mode = 'failure';
  const failed = await check(); assert.equal(failed.status, 400, await failed.text());
  const afterFailure = await s.view(assigned.run.id);
  for (const product of [high, superHigh]) {
    const before = itemFor(registered, product).naverRegistration;
    assert.deepEqual(itemFor(afterFailure, product).naverRegistration, { ...before, fresh: false, matches: null });
    assert.equal(itemFor(afterFailure, product).trackingNumber, product.trackingNumber);
  }
  const sourceResponse = await fetch(s.base + '/api/invoices/orders?batchIds=' + encodeURIComponent(JSON.stringify([s.batch.batch.id])));
  const source = await sourceResponse.json(); assert.equal(sourceResponse.status, 200, JSON.stringify(source));
  for (const product of source.currentOrders.flatMap(order => order.latestStatus.products)) {
    assert.equal(product.naverRegistration.fresh, false); assert.equal(product.naverRegistration.matches, null);
  }
  s.assertSourceUntouched();
  mode = 'registered';
  const refreshed = await check(); assert.equal(refreshed.status, 200, await refreshed.text());
  const valid = await s.view(assigned.run.id);
  const change = await fetch(s.base + `/api/batches/${s.batch.batch.id}/rows`, { ...jsonOptions({ changes: [{ id: s.batch.rows[0].id,
    cleanedName: high.productName + ' 근거 수정', status: 'confirmed', reviewNote: '' }] }), method: 'PATCH' });
  assert.equal(change.status, 200, await change.text());
  const invalid = await s.view(assigned.run.id);
  assert.equal(itemFor(invalid, high).assignmentValid, false);
  assert.deepEqual(itemFor(invalid, high).naverRegistration, { ...itemFor(valid, high).naverRegistration, fresh: false, matches: null });
});

test('상품별 송장과 원본 연결은 서버를 재시작해도 보존된다', async t => {
  const s = await setup(t, { fileBacked: true }), initial = await s.start();
  const assigned = await s.select(initial, [choiceFor(initial, high), choiceFor(initial, superHigh)]);
  const original = await s.build(assigned);
  await s.restart();
  const restored = await s.view(initial.run.id);
  assertAssigned(restored, high, s.batch.rows[0].id); assertAssigned(restored, superHigh, s.batch.rows[1].id);
  assert.equal(restored.trackingReview.pendingCount, 0);
  const saved = await fetch(s.base + `/api/invoices/${initial.run.id}/download`);
  assert.equal(saved.status, 200); assert.deepEqual(Buffer.from(await saved.arrayBuffer()), original);
  s.assertSourceUntouched();
});

test('두 상품을 한 출고에 선택한 뒤에도 다른 출고 후보를 잃지 않고 각 상품의 송장을 정정할 수 있다', async t => {
  const s = await setup(t), initial = await s.start();
  const shared = await s.select(initial, [choiceFor(initial, high), { ...choiceFor(initial, superHigh), trackingNumber: high.trackingNumber }]);
  const group = groupFor(shared, superHigh);
  assert.ok(group.candidates.some(parcel => parcel.trackingNumber === superHigh.trackingNumber && parcel.selectable));
  const corrected = await s.select(shared, [choiceFor(shared, superHigh)]);
  assertAssigned(corrected, high, s.batch.rows[0].id); assertAssigned(corrected, superHigh, s.batch.rows[1].id);
  s.assertSourceUntouched();
});

test('서로 다른 출고에 같은 송장번호가 중복되면 어느 출고인지 단정해 저장하지 않는다', async t => {
  const s = await setup(t), initial = await s.start([high, { ...superHigh, trackingNumber: high.trackingNumber }]);
  assert.equal(groupFor(initial, high).assignEligible, false);
  const response = await fetch(s.base + `/api/invoices/${initial.run.id}/tracking`, jsonOptions({ expectedVersion: initial.viewVersion,
    choices: [choiceFor(initial, high)] }));
  assert.equal(response.status, 400, await response.text());
  assert.ok((await s.view(initial.run.id)).items.every(item => !item.shipmentAssignment));
  s.assertSourceUntouched();
});
