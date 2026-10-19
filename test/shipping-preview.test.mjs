import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { importFiles } from '../lib/excel.mjs';
import { reviseRows } from '../lib/naming.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `system0-preview-absent-${randomUUID()}.env`);
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');
const from = '2026-10-10T01:00:00.000Z', to = '2026-10-17T01:00:00.000Z';
const order = (productOrderId, optionName = '옵션 A', quantity = 1) => ({ productOrderId, orderId: '202610170000000001',
  originalName: '원본 상품', productName: '원본 상품', optionName, quantity,
  recipient: '모의 수취인', phone: '010-1111-2222', address: '서울 강남구 테헤란로 123 (역삼동, 비공개빌딩) 101호' });
const answer = request => ({ output_text: JSON.stringify({ items: JSON.parse(request.input).map(item => ({ id: item.id,
  cleanedName: item.optionName === '옵션 B' ? '확인이 필요한 상품' : '정리된 상품',
  needsAttention: item.optionName === '옵션 B', note: item.optionName === '옵션 B' ? '소재 확인 필요' : '' })) }),
  usage: { total_tokens: 50 } });
const snapshot = db => Object.fromEntries(['batches', 'sheets', 'source_files', 'rows', 'row_revisions']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
async function setup(t, options) {
  const app = createApp({ databasePath: ':memory:', ...options });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  return { db: app.locals.db, base: `http://127.0.0.1:${server.address().port}`, app };
}
function seed(db) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['상품명', '옵션명'], ['기존 원본', '기존 옵션'],
  ]), '주문');
  const saved = importFiles(db, [{ originalname: '보존할 주문.xlsx', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) }]);
  reviseRows(db, saved.batch.id, [{ id: saved.rows[0].id, cleanedName: '직원 확정 명칭', reviewNote: '보존할 직원 메모', status: 'confirmed' }]);
  return saved;
}

test('신규 API는 잔여 수량을 집계하고 상품주문 행·긴 ID를 보존하며 주문·직원수정은 쓰지 않는다', async t => {
  let reads = 0, aiCalls = 0;
  const { base, db } = await setup(t, { naver: { async listNewOrders() {
    reads++; return { from, to, orders: [order('202610170000000011', '옵션 A', 3), order('202610170000000012'), order('202610170000000013', '옵션 B', 2)] };
  } }, client: { responses: { async create(request) {
    aiCalls++;
    for (const value of ['모의 수취인', '010-1111', '테헤란로', '202610170000000001']) assert.ok(!request.input.includes(value));
    return answer(request);
  } } } });
  seed(db);
  const before = snapshot(db);
  assert.equal((await fetch(base + '/api/shipping/preview')).status, 404);
  assert.equal(reads, 0, '화면 열기·GET만으로 신규 조회나 유료 정리를 실행하지 않습니다.');
  const response = await fetch(base + '/api/shipping/preview', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.mode, 'new');
  assert.deepEqual(result.summary, { orderCount: 1, rowCount: 3, quantity: 6, groupCount: 2, attentionQuantity: 2 });
  assert.equal(result.from, from); assert.equal(result.to, to);
  assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
  assert.equal(result.groups[0].count, 4);
  assert.equal(result.groups[0].shipments.length, 2);
  assert.deepEqual(result.groups[0].shipments.map(row => row.id), ['202610170000000011', '202610170000000012']);
  assert.ok(result.groups.flatMap(group => group.shipments).every(row => typeof row.orderId === 'string' && row.neighborhood === '서울 강남구 역삼동'));
  assert.equal(result.groups[1].shipments[0].note, '소재 확인 필요');
  assert.ok(result.groups.every(group => group.invoiceState === 'unavailable'));
  for (const forbidden of ['테헤란로', '123', '비공개빌딩', '101호', 'originalName', 'address']) assert.ok(!JSON.stringify(result).includes(forbidden));
  assert.deepEqual(snapshot(db), before);
  assert.equal(reads, 1); assert.equal(aiCalls, 1);
  const calls = db.prepare('SELECT * FROM llm_calls').all();
  assert.equal(calls.length, 1); assert.equal(calls[0].batch_id, null);
  assert.equal(calls[0].purpose_code, 'product_names_preview');
  assert.equal(calls[0].item_count, 2);
  assert.ok(!JSON.stringify(calls).includes('모의 수취인'));
  const usage = await (await fetch(base + '/api/llm/purposes')).json();
  assert.ok(usage.purposes.some(item => item.code === 'product_names_preview'));
});

test('갱신 결과는 이전 목록을 누적하지 않고 0건도 성공하며 조회·정리 실패 후 재실행할 수 있다', async t => {
  let reads = 0, calls = 0;
  const { base, db } = await setup(t, { naver: { async listNewOrders() {
    reads++;
    if (reads === 3) throw new Error('모의 네이버 장애');
    return { from, to, orders: reads === 2 ? [] : [order(String(reads))] };
  } }, client: { responses: { async create(request) {
    calls++; if (calls === 2) throw Object.assign(new Error('비공개 원문 오류'), { status: 429 });
    return answer(request);
  } } } });
  seed(db); const before = snapshot(db);
  const request = () => fetch(base + '/api/shipping/preview', { method: 'POST' });
  assert.equal((await (await request()).json()).summary.rowCount, 1);
  const empty = await request();
  assert.equal(empty.status, 200); const data = await empty.json();
  assert.deepEqual(data.groups, []); assert.equal(data.summary.quantity, 0);
  assert.equal((await request()).status, 400);
  const failedAi = await request(); assert.equal(failedAi.status, 400);
  assert.ok(!(await failedAi.text()).includes('비공개 원문 오류'));
  const retried = await request(); assert.equal(retried.status, 200);
  assert.equal((await retried.json()).groups[0].shipments[0].id, '5');
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(db.prepare('SELECT status FROM llm_calls ORDER BY id').all().map(row => row.status), ['succeeded', 'failed', 'succeeded']);
});

test('중복 갱신·외부 페이지 호출을 막고 실행 완료 후 다시 갱신할 수 있다', async t => {
  let finish, calls = 0;
  const { base } = await setup(t, { client: null, naver: { listNewOrders() {
    calls++;
    return new Promise(resolve => { finish = () => resolve({ from, to, orders: [] }); });
  } } });
  assert.equal((await fetch(base + '/api/shipping/preview', { method: 'POST', headers: { Origin: 'https://external.invalid' } })).status, 403);
  assert.equal(calls, 0);
  const first = fetch(base + '/api/shipping/preview', { method: 'POST' });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const duplicate = await fetch(base + '/api/shipping/preview', { method: 'POST' });
  assert.equal(duplicate.status, 409); assert.equal(calls, 1);
  finish(); assert.equal((await first).status, 200);
  const next = fetch(base + '/api/shipping/preview', { method: 'POST' });
  while (calls < 2) await new Promise(resolve => setImmediate(resolve));
  finish(); assert.equal((await next).status, 200);
});
