import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import * as XLSX from 'xlsx';
import officeCrypto from 'officecrypto-tool';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { initializeDiscordWorkflow, claimDiscordRequest, finishDiscordRequest, discordContext } from '../lib/discord-workflow.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `system0-discord-absent-${randomUUID()}.env`);
process.env.DISCORD_ENV_FILE = path.join(os.tmpdir(), `system0-discord-absent-${randomUUID()}.env`);
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');
const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const otherUser = '444444444444444444', secret = 'isolated-discord-workflow-secret-32chars';
const config = { secret, guildId: scope.guildId, channelIds: [scope.channelId], userIds: [scope.userId, otherUser] };
const requestId = '555555555555555555', orderId = '202611130000000099', productId = '202611130000000001';
const tracking = '001234567890', date = '2026-11-13';
const recipient = '테스트 수취인', phone = '010-0000-0000', address = '서울 강남구 테스트로 1 101호';
function file(name, rows) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '주문');
  return { originalname: name, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}
const legacy = () => file('기존 출고.xlsx', [['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량'],
  ['직원 확인 상품', '000001', orderId, recipient, phone, address, 1]]);
const naver = (extra = false) => file('임의 첫 파일.xlsx', [['보고서'], [],
  ['상품주문번호', '주문번호', '상품명', '수량', '수취인명', '수취인연락처1', '통합배송지', '주문상태', ...(extra ? ['메모'] : [])],
  [productId, orderId, '직원 확인 상품', 1, recipient, phone, address, 'PAYED']]);
const courier = () => file('임의 두 번째 파일.xlsx', [['운송장번호', '주문번호', '차수', '물품명'], [tracking, '000001', 1, '직원 확인 상품']]);
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function filesForm(files, password) {
  const body = new FormData();
  for (const item of files) body.append('files', new Blob([item.buffer]), item.originalname);
  body.append('sourceDate', date); body.append('deliveryCompanyCode', 'KGB');
  if (password !== undefined) body.append('naverPassword', password);
  return body;
}
async function boot(t, options = {}) {
  const app = createApp({ databasePath: ':memory:', apiKey: '', client: null, discordConfig: config,
    naver: { queryProductOrders: async () => [] }, ...options });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); app.locals.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { 'X-System0-Discord-Key': secret, ...options.headers } });
  return { db: app.locals.db, request, base };
}
async function imported(request, files = [courier(), naver()], password) {
  const response = await request('/api/invoices/import', { method: 'POST', body: filesForm(files, password) });
  assert.equal(response.status, 201, (await response.clone().json()).error);
  return response.json();
}
const contextRoute = userId => '/api/discord/context?' + new URLSearchParams({ ...scope, userId: userId || scope.userId });

test('Discord 비설정은 404, 비밀키·서버·채널·직원과 공개 Host를 각각 검증한다', async t => {
  const disabled = await boot(t, { discordConfig: null });
  assert.equal((await disabled.request(contextRoute())).status, 404);
  const { db, request, base } = await boot(t, { publicOrigin: 'https://system0.example' });
  assert.deepEqual(await (await request(contextRoute())).json(), { runId: null, date: null });
  for (const key of ['', 'wrong', secret + 'x']) assert.equal((await request(contextRoute(), { headers: { 'X-System0-Discord-Key': key } })).status, 403);
  for (const field of ['guildId', 'channelId', 'userId']) {
    const query = new URLSearchParams({ ...scope, [field]: '999999999999999999' });
    assert.equal((await request('/api/discord/context?' + query)).status, 403);
  }
  const publicStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base + contextRoute(), { headers: { Host: 'system0.example', 'X-System0-Discord-Key': secret } }, response => {
      response.resume(); resolve(response.statusCode);
    }); req.on('error', reject); req.end();
  });
  assert.equal(publicStatus, 403);
  assert.equal(db.prepare('SELECT count(*) n FROM discord_requests').get().n, 0);
  assert.equal((await request(contextRoute())).headers.get('cache-control'), 'no-store');
});

test('동일 이벤트 claim/결과는 멱등이고 payload·다른 직원의 완료 변경을 거부한다', async t => {
  const { db, request } = await boot(t); importFiles(db, [legacy()]);
  const invoice = await imported(request), body = { ...scope, requestId, action: 'create_invoice', date };
  assert.equal((await request('/api/discord/requests', json('POST', body))).status, 201);
  const duplicate = await request('/api/discord/requests', json('POST', body));
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'discord_request_running');
  const changed = await request('/api/discord/requests', json('POST', { ...body, date: '2026-11-12' }));
  assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'discord_request_mismatch');
  const wrongUser = await request(`/api/discord/requests/${requestId}`, json('PATCH', { ...scope, userId: otherUser, status: 'succeeded' }));
  assert.equal(wrongUser.status, 404);
  const result = { ...scope, status: 'succeeded', runId: invoice.run.id, date };
  const done = await (await request(`/api/discord/requests/${requestId}`, json('PATCH', result))).json();
  const again = await (await request(`/api/discord/requests/${requestId}`, json('PATCH', result))).json();
  assert.deepEqual(again, done);
  const replay = await request('/api/discord/requests', json('POST', body));
  assert.equal(replay.status, 200); assert.equal((await replay.json()).request.runId, invoice.run.id);
  assert.equal((await request(`/api/discord/requests/${requestId}`, json('PATCH', { ...result, status: 'failed' }))).status, 409);
  assert.deepEqual(await (await request(contextRoute(otherUser))).json(), { runId: invoice.run.id, date });
  for (const [index, action, status] of [[1, 'help', 'succeeded'], [2, 'check_registration', 'succeeded'], [3, 'create_invoice', 'failed']]) {
    const id = String(BigInt(requestId) + BigInt(index));
    assert.equal((await request('/api/discord/requests', json('POST', { ...scope, requestId: id, action, date }))).status, 201);
    assert.equal((await request(`/api/discord/requests/${id}`, json('PATCH', { ...scope, status, date: '2026-11-12' }))).status, 200);
  }
  assert.deepEqual(await (await request(contextRoute())).json(), { runId: invoice.run.id, date });
  assert.equal(db.prepare('SELECT count(*) n FROM discord_requests').get().n, 4);
});

test('재시작된 running 요청은 interrupted로 남고 자동 재실행하지 않는다', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-discord-')), filename = path.join(directory, 'fixture.sqlite');
  let db;
  try {
    db = openDatabase(filename); initializeDiscordWorkflow(db);
    claimDiscordRequest(db, { ...scope, requestId, action: 'help', date });
    const finishedId = String(BigInt(requestId) + 1n);
    claimDiscordRequest(db, { ...scope, requestId: finishedId, action: 'help', date });
    finishDiscordRequest(db, finishedId, { ...scope, status: 'succeeded' });
    db.close(); db = openDatabase(filename); initializeDiscordWorkflow(db);
    assert.throws(() => claimDiscordRequest(db, { ...scope, requestId, action: 'help', date }), error => error.httpStatus === 409 && error.request.status === 'interrupted');
    assert.equal(claimDiscordRequest(db, { ...scope, requestId: finishedId, action: 'help', date }).request.status, 'succeeded');
    assert.deepEqual(discordContext(db, scope), { runId: null, date: null });
  } finally {
    db?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^system0-discord-/);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('일반 첨부는 헤더로 구분하고 암호화 네이버 원본을 보존하며 혼합·역할누락을 거부한다', async t => {
  const { db, request } = await boot(t); importFiles(db, [legacy()]);
  const password = 'isolated-file-' + randomUUID(), original = naver();
  const encrypted = { ...original, buffer: officeCrypto.encrypt(original.buffer, { password }) };
  const wrong = await request('/api/invoices/import', { method: 'POST', body: filesForm([encrypted, courier()], 'wrong') });
  assert.equal(wrong.status, 400); assert.ok(!(await wrong.json()).error.includes(password));
  const view = await imported(request, [courier(), encrypted], password);
  assert.equal(view.items[0].productOrderId, productId); assert.equal(view.items[0].trackingNumber, tracking);
  const saved = db.prepare("SELECT content FROM invoice_files WHERE run_id = ? AND kind = 'naver'").get(view.run.id);
  assert.ok(Buffer.from(saved.content).equals(encrypted.buffer));
  assert.ok(!JSON.stringify(view).includes(password));
  const mixed = filesForm([naver(), courier()]); mixed.append('naverFiles', new Blob([original.buffer]), original.originalname);
  assert.equal((await request('/api/invoices/import', { method: 'POST', body: mixed })).status, 400);
  for (const files of [[naver()], [courier()], [file('알수없음.xlsx', [['어떤 파일']]), courier()]]) {
    assert.equal((await request('/api/invoices/import', { method: 'POST', body: filesForm(files) })).status, 400);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM invoice_runs').get().n, 1);
});

test('공통 파일 API는 stale 검토/관련 최신 상태를 차단하고 보관본 자동선택은 원래 hash를 보존한다', async t => {
  const { db, request } = await boot(t); importFiles(db, [legacy()]);
  let view = await imported(request);
  assert.equal(view.viewVersion, (await (await request(`/api/invoices/${view.run.id}`)).json()).viewVersion);
  const fileRequest = (version, mode = 'auto') => request(`/api/invoices/${view.run.id}/file`, json('POST', { mode, expectedVersion: version }));
  const firstVersion = view.viewVersion;
  const patched = await request(`/api/invoices/${view.run.id}/items`, json('PATCH', { changes: [{ id: view.items[0].id, decision: 'include', note: '직원 수정' }] }));
  view = await patched.json(); assert.notEqual(view.viewVersion, firstVersion);
  const stale = await fileRequest(firstVersion); assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'stale_invoice_version');
  const generated = await fileRequest(view.viewVersion); assert.equal(generated.status, 200);
  const bytes = Buffer.from(await generated.arrayBuffer()), hash = value => createHash('sha256').update(value).digest('hex');
  view = await (await request(`/api/invoices/${view.run.id}`)).json();
  const before = hash(db.prepare('SELECT generated_file FROM invoice_runs WHERE id = ?').get(view.run.id).generated_file);
  view = await (await request(`/api/invoices/${view.run.id}/items`, json('PATCH', { changes: [{ id: view.items[0].id, decision: 'hold', note: '웹 검토 중' }] }))).json();
  const saved = await fileRequest(view.viewVersion); assert.equal(saved.status, 200); assert.ok(Buffer.from(await saved.arrayBuffer()).equals(bytes));
  assert.equal((await fileRequest(view.viewVersion, 'rebuild')).status, 400);
  assert.equal(hash(db.prepare('SELECT generated_file FROM invoice_runs WHERE id = ?').get(view.run.id).generated_file), before);
  const priorVersion = view.viewVersion, priorItems = db.prepare('SELECT * FROM invoice_items WHERE run_id = ?').all(view.run.id);
  await imported(request, [naver(true), courier()]);
  const changed = await (await request(`/api/invoices/${view.run.id}`)).json(); assert.notEqual(changed.viewVersion, priorVersion);
  assert.deepEqual(db.prepare('SELECT * FROM invoice_items WHERE run_id = ?').all(view.run.id), priorItems);
  assert.equal((await fileRequest(priorVersion)).status, 409);
});

test('누락·미해결 주문은 봇 파일 요청으로 강제 포함하지 않으며 임의 검수 payload를 받지 않는다', async t => {
  const { db, request } = await boot(t);
  const view = await imported(request);
  assert.ok(view.items.some(item => item.decision === 'hold'));
  const output = await request(`/api/invoices/${view.run.id}/file`, json('POST', { mode: 'auto', expectedVersion: view.viewVersion }));
  assert.equal(output.status, 400);
  const forced = await request(`/api/invoices/${view.run.id}/file`, json('POST', {
    mode: 'auto', expectedVersion: view.viewVersion, changes: [{ id: view.items[0].id, decision: 'include' }],
  }));
  assert.equal(forced.status, 400);
  assert.equal(db.prepare('SELECT count(*) n FROM invoice_revisions').get().n, 0);
  assert.equal(db.prepare('SELECT generated_file FROM invoice_runs WHERE id = ?').get(view.run.id).generated_file, null);
});

test('자연어 분류는 고객정보 없는 업무 상태를 보내고 허용 action/schema/store:false 및 실제 호출기록을 검증한다', async t => {
  let answer = { action: 'create_invoice', date }, sent;
  const client = { responses: { create: async request => { sent = request; return { output_text: JSON.stringify(answer), usage: { total_tokens: 10 } }; } } };
  const { db, request } = await boot(t, { client, model: 'mock-model' }); importFiles(db, [legacy()]);
  const view = await imported(request), before = db.prepare('SELECT * FROM invoice_items').all();
  const body = { ...scope, requestId, text: '첨부 파일로 송장 엑셀 만들어 줘', date, hasAttachments: true, runId: view.run.id };
  const result = await request('/api/discord/interpret', json('POST', body));
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), answer);
  const input = JSON.parse(sent.input);
  assert.deepEqual({ ...input, workflow: undefined }, { text: body.text, date, hasAttachments: true, workflow: undefined });
  assert.equal(input.workflow.runId, view.run.id); assert.equal(input.workflow.total, 1);
  assert.equal(input.workflow.selectionRequired, 0); assert.ok(input.workflow.allowedNextActions.includes('rebuild_file'));
  assert.equal(sent.store, false); assert.equal(sent.text.format.strict, true); assert.equal(sent.text.format.type, 'json_schema');
  for (const value of [recipient, phone, address, productId, secret, scope.guildId, scope.channelId, scope.userId]) assert.ok(!sent.input.includes(value));
  assert.equal(db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose_code = 'discord_requests' AND status = 'succeeded'").get().n, 1);
  for (const invalid of [{ action: 'cancel_orders', date }, { action: 'help', date: '2026-02-30' }, { action: 'help', date: null, runId: 123 }]) {
    answer = invalid;
    assert.equal((await request('/api/discord/interpret', json('POST', body))).status, 400);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM llm_calls WHERE purpose_code = 'discord_requests' AND status = 'failed'").get().n, 3);
  assert.deepEqual(db.prepare('SELECT * FROM invoice_items').all(), before);
  assert.equal(db.prepare('SELECT count(*) n FROM discord_requests').get().n, 0, '해석 자체가 업무를 실행하거나 완료 처리하지 않습니다.');
});
