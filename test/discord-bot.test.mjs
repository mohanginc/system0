import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordHandler, discordAttachment, discordButtonId, parseDiscordButton, readDiscordBytes } from '../lib/discord-bot.mjs';
import { readDiscordConfig } from '../lib/discord-config.mjs';
import { createDiscordTrace } from '../lib/discord-trace.mjs';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';

const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const config = { secret: 'a'.repeat(64), guildId: scope.guildId, channelIds: [scope.channelId], userIds: [scope.userId],
  baseUrl: 'http://127.0.0.1:3000', publicOrigin: 'https://system0.example.com', naverPassword: 'private-file-password' };
const detail = { run: { id: 7, sourceDate: '2026-11-13' }, viewVersion: 'version-1', currentSummary: { total: 2, complete: 0, ready: 2 },
  items: [{ decision: 'include', registrationState: 'unchecked' }], fileActions: { create: true, rebuild: false, saved: false, reviewRequired: false } };
const event = { ...scope, id: '444444444444444444', action: 'create_invoice', date: '2026-11-13', attachments: [
  { name: 'naver.xlsx', size: 4, url: 'https://cdn.discordapp.com/attachments/123/456/naver.xlsx?ex=example' },
  { name: 'courier.xls', size: 4, url: 'https://media.discordapp.net/attachments/123/789/courier.xls?ex=example' },
] };
const response = value => Response.json(value);
function fakeServer({ fileStatus = 200 } = {}) {
  const calls = [], jobs = new Map(); let context = { runId: null, date: null };
  return { calls, jobs, fetcher: async (url, options = {}) => {
    const route = String(url).replace(config.baseUrl, ''); calls.push({ route, options });
    if (String(url).startsWith('https:')) { assert.equal(options.headers, undefined); return new Response('data'); }
    assert.equal(options.headers['X-System0-Discord-Key'], config.secret);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    if (route.startsWith('/api/discord/context?')) return response(context);
    if (route === '/api/discord/interpret') return response({ action: 'create_invoice', date: '2026-11-13' });
    if (route === '/api/discord/requests') {
      if (jobs.has(body.requestId)) return response({ request: jobs.get(body.requestId) });
      const request = { ...body, status: 'running' }; jobs.set(body.requestId, request); return response({ request });
    }
    if (route.startsWith('/api/discord/requests/')) {
      const id = route.split('/').at(-1); Object.assign(jobs.get(id), body);
      if (body.status === 'succeeded' && body.runId) context = { runId: body.runId, date: body.date };
      return response({ request: jobs.get(id) });
    }
    if (route === '/api/invoices/import') {
      assert.equal(body.getAll('files').length, 2); assert.equal(body.get('naverPassword'), config.naverPassword);
      assert.equal(body.get('sourceDate'), event.date); assert.equal(body.get('deliveryCompanyCode'), 'KGB'); return response(detail);
    }
    if (route === '/api/invoices/7') return response(detail);
    if (route === '/api/invoices/7/file') {
      assert.deepEqual(body, { mode: 'auto', expectedVersion: 'version-1' });
      return fileStatus === 200 ? new Response('xlsx', { headers: { 'Content-Disposition': "attachment; filename*=UTF-8''result.xlsx" } })
        : Response.json({ error: '검토 내용을 먼저 확인해 주세요.' }, { status: fileStatus });
    }
    throw new Error('Unexpected mock route: ' + route);
  } };
}

test('디스코드가 한글 파일명을 바꿔도 title과 원래 엑셀 확장자로 표시이름을 보존한다', () => {
  for (const [name, title, expected] of [
    ['hash.xlsx', '연결테스트_네이버', '연결테스트_네이버.xlsx'],
    ['hash.xlsx', '연결테스트_네이버.xlsx', '연결테스트_네이버.xlsx'],
    ['hash.XLS', '연결테스트_로젠.xls', '연결테스트_로젠.xls'],
    ['기존파일.xlsx', undefined, '기존파일.xlsx'],
    ['문서.pdf', '이름.xlsx', '문서.pdf'],
  ]) {
    assert.deepEqual(discordAttachment({ name, title, size: 4, url: event.attachments[0].url }),
      { name: expected, size: 4, url: event.attachments[0].url });
  }
});

test('첨부 title의 경로·제어문자를 치환해 허용하지 않고 기존 파일명 검증에서 거부한다', async () => {
  for (const [name, title] of [
    ['hash.xlsx', '../네이버'], ['hash.xlsx', '폴더\\네이버'],
    ['hash.xlsx', '네이버\r\n파일'], ['hash.xlsx', '네이버\0파일'],
    ['../hash.xlsx', '안전한이름'],
  ]) {
    const mock = fakeServer(), handle = createDiscordHandler({ config, fetcher: mock.fetcher });
    const output = await handle({ ...event, attachments: [discordAttachment({ ...event.attachments[0], name, title }), event.attachments[1]] });
    assert.match(output.content, /파일만 사용할 수/);
    assert.equal(mock.calls.some(call => call.route.startsWith('https:') || call.route === '/api/invoices/import'), false);
  }
});

test('디스코드 설정은 서버·채널·직원 ID와 로컬 주소를 명시하고 외부 API 주소를 거부한다', () => {
  assert.equal(readDiscordConfig({}), null);
  const env = { DISCORD_API_SECRET: config.secret, DISCORD_GUILD_ID: scope.guildId, DISCORD_CHANNEL_IDS: scope.channelId,
    DISCORD_USER_IDS: scope.userId, DISCORD_BOT_TOKEN: 'fake-token' };
  assert.equal(readDiscordConfig(env, { worker: true }).baseUrl, 'http://127.0.0.1:3000');
  assert.throws(() => readDiscordConfig({ ...env, DISCORD_API_BASE: 'https://outside.example.com' }));
  assert.throws(() => readDiscordConfig({ ...env, DISCORD_USER_IDS: '*' }));
  assert.throws(() => readDiscordConfig({ ...env, DISCORD_API_SECRET: 'short' }));
});

test('파일 첨부 요청은 기존 매칭·파일 API를 사용하고 내부 키·파일 암호를 외부 첨부 주소나 답변에 보내지 않는다', async () => {
  const mock = fakeServer(), handle = createDiscordHandler({ config, fetcher: mock.fetcher });
  const output = await handle({ ...event, action: undefined, text: '네이버 송장 입력용 파일 만들어줘' });
  assert.equal(output.files[0].name, 'result.xlsx'); assert.equal(output.files[0].attachment.toString(), 'xlsx');
  assert.ok(output.components[0].components[0].url.endsWith('/invoices.html?run=7'));
  const interpret = JSON.parse(mock.calls.find(call => call.route === '/api/discord/interpret').options.body);
  assert.equal(Object.hasOwn(interpret, 'attachments'), false); assert.equal(Object.hasOwn(interpret, 'naverPassword'), false);
  assert.equal(JSON.stringify(output).includes(config.naverPassword), false);
  assert.equal(mock.calls.some(call => /\/export|\/items|\/check-date/.test(call.route)), false);
});

test('송장 요청의 첨부·업무 API·최종 답변을 같은 ID로 보관하고 암호와 엑셀 원문은 남기지 않는다', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-discord-request-log-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = createDiscordTrace({ directory, secrets: [config.secret, config.naverPassword] });
  for (const [id, fileStatus] of [[event.id, 200], ['555555555555555556', 409]]) {
    const mock = fakeServer({ fileStatus });
    const fetcher = async (url, options) => {
      const result = await mock.fetcher(url, options);
      return url.endsWith('/api/invoices/import') ? response({ ...detail, items: [{ recipient: 'private-customer-marker' }] }) : result;
    };
    await createDiscordHandler({ config, fetcher, trace })({ ...event, id, kind: 'message',
      text: '네이버주문파일 비밀번호는 8462이야. 네이버 입력용 파일 만들어줘.' });
  }

  const raw = readdirSync(directory).map(file => readFileSync(path.join(directory, file), 'utf8')).join('');
  for (const secret of ['8462', config.secret, config.naverPassword, 'private-customer-marker', 'cdn.discordapp.com', 'ex=example']) {
    assert.equal(raw.includes(secret), false);
  }
  const events = raw.trim().split('\n').map(JSON.parse);
  const success = events.filter(row => row.requestId === event.id);
  assert.match(success.find(row => row.stage === 'request.start').text, /비밀번호는 \[가림\]/);
  assert.deepEqual(success.filter(row => row.stage === 'attachment.result').map(row => [row.name, row.sizeBytes, row.status]),
    [['naver.xlsx', 4, 200], ['courier.xls', 4, 200]]);
  const matched = success.find(row => row.stage === 'api.result' && row.endpoint === '/api/invoices/import');
  assert.equal(matched.result.runId, 7);
  assert.equal(matched.result.counts.ready, 2);
  assert.equal(success.find(row => row.stage === 'api.start' && row.endpoint === '/api/invoices/import').parameters.naverDecryptionConfigured, true);
  const output = success.find(row => row.stage === 'request.result');
  assert.match(output.text, /네이버 업로드용 파일/);
  assert.deepEqual(output.files, [{ name: 'result.xlsx', sizeBytes: 4 }]);
  const failure = events.find(row => row.requestId !== event.id && row.stage === 'api.result' && row.endpoint === '/api/invoices/7/file');
  assert.equal(failure.status, 409);
  assert.equal(failure.outcome, 'error');
  assert.match(failure.error, /검토 내용을 먼저/);
});

test('진단 로그 콜백이 실패해도 송장 파일을 반환한다', async () => {
  const mock = fakeServer();
  const output = await createDiscordHandler({ config, fetcher: mock.fetcher, trace: () => { throw new Error('sink unavailable'); } })(event);
  assert.equal(output.files[0].name, 'result.xlsx');
});

test('같은 디스코드 이벤트 재수신은 파일을 다시 업로드·생성하지 않는다', async () => {
  const mock = fakeServer(), handle = createDiscordHandler({ config, fetcher: mock.fetcher });
  await handle(event); const again = await handle(event);
  assert.match(again.content, /이미 처리/);
  assert.equal(mock.calls.filter(call => call.route === '/api/invoices/import').length, 1);
  assert.equal(mock.calls.filter(call => call.route === '/api/invoices/7/file').length, 1);
});

test('미허용 직원은 첨부 다운로드·내부 API·AI 호출 전 거부한다', async () => {
  let calls = 0; const handle = createDiscordHandler({ config, fetcher: async () => { calls++; throw new Error('Must not call'); } });
  assert.match((await handle({ ...event, userId: '555555555555555555' })).content, /권한/); assert.equal(calls, 0);
});

test('새 매칭의 첨부 처리 실패는 이전 채널 작업을 실패 요청의 결과로 연결하지 않는다', async () => {
  const mock = fakeServer(), handle = createDiscordHandler({ config, fetcher: mock.fetcher });
  await handle(event);
  const failedEvent = { ...event, id: '777777777777777777', attachments: [{ ...event.attachments[0], url: 'https://outside.example.com/file.xlsx' }, event.attachments[1]] };
  assert.match((await handle(failedEvent)).content, /직접 첨부/);
  assert.equal(mock.jobs.get(failedEvent.id).runId ?? null, null);
  const retry = await handle(failedEvent); assert.match(retry.content, /실패/); assert.equal(retry.components, undefined);
});

test('첨부 링크는 디스코드 CDN만 허용하고 용량 초과·리디렉션을 제한한다', async () => {
  const mock = fakeServer(), handle = createDiscordHandler({ config, fetcher: mock.fetcher });
  const output = await handle({ ...event, attachments: [{ ...event.attachments[0], url: 'http://127.0.0.1/private.xlsx' }, event.attachments[1]] });
  assert.match(output.content, /직접 첨부/); assert.equal(mock.calls.some(call => call.route === '/api/invoices/import'), false);
  await assert.rejects(readDiscordBytes(new Response('too large'), 2), /10MB/);
  await assert.rejects(readDiscordBytes(new Response(''), 10), /빈 파일/);
});

test('검토 필요·stale 409는 파일을 만들거나 경고를 자동 해제하지 않고 해당 작업 링크를 보낸다', async () => {
  for (const fileStatus of [400, 409]) {
    const mock = fakeServer({ fileStatus }), output = await createDiscordHandler({ config, fetcher: mock.fetcher })(event);
    assert.equal(output.files, undefined); assert.match(output.content, /검토/); assert.ok(output.components.length);
    assert.equal(mock.calls.some(call => /\/items|\/export|rebuild/.test(call.route)), false);
  }
});

test('작업 버튼은 서버·채널에 서명되어 다른 채널 전달과 송장 작업 번호 변조를 거부한다', () => {
  const id = discordButtonId(config, scope, 'download_file', 7, event.date);
  assert.deepEqual(parseDiscordButton(config, scope, id), { action: 'download_file', runId: 7, date: event.date });
  assert.throws(() => parseDiscordButton(config, { ...scope, channelId: '555555555555555555' }, id));
  assert.throws(() => parseDiscordButton(config, scope, id.replace(':7:', ':8:')));
});

test('다른 날짜의 파일 요청은 채널의 최근 작업을 대신 보내지 않고 지정 날짜에서 찾는다', async () => {
  const calls = [];
  const handle = createDiscordHandler({ config, fetcher: async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('/api/discord/context?')) return response({ runId: 7, date: '2026-11-13' });
    if (String(url).endsWith('/api/invoices/latest?date=2026-11-12')) return response({ invoice: null });
    throw new Error('Must not use wrong run');
  } });
  const result = await handle({ ...event, action: 'download_file', date: '2026-11-12', attachments: [] });
  assert.match(result.content, /2026-11-12/); assert.equal(result.files, undefined);
  assert.equal(calls.some(url => url.includes('/invoices/7')), false);
});

test('봇 요청부터 실제 업무 HTTP API·엑셀 생성·저장본 재다운로드까지 격리 DB에서 이어진다', async t => {
  process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `discord-test-absent-${randomUUID()}.env`);
  process.env.DISCORD_ENV_FILE = path.join(os.tmpdir(), `discord-test-absent-${randomUUID()}.env`);
  const { createApp } = await import('../server.mjs');
  const app = createApp({ databasePath: ':memory:', apiKey: '', client: null, discordConfig: config,
    naver: { queryProductOrders: async () => { throw new Error('No live Naver calls allowed'); } } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); app.locals.db.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const workbook = rows => { const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '주문'); return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }); };
  const productId = '202611130000000001', orderId = '202611130000000099', internal = '000001', tracking = '001234567890';
  const customer = ['검증 수취인', '010-0000-0000', '서울 검증로 1'];
  const source = workbook([['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량', '쇼핑몰'],
    ['검증 쿠션', internal, orderId, ...customer, 1, '네이버']]);
  const form = new FormData(); form.append('files', new Blob([source]), 'source.xlsx');
  assert.equal((await fetch(baseUrl + '/api/import', { method: 'POST', body: form })).status, 201);
  const naver = workbook([['상품주문번호', '주문번호', '수취인명', '수취인연락처1', '통합배송지', '상품명', '수량', '주문상태'],
    [productId, orderId, ...customer, '검증 쿠션', 1, '발송대기']]);
  const courier = workbook([['주문번호', '운송장번호'], [internal, tracking]]);
  const handle = createDiscordHandler({ config: { ...config, baseUrl }, fetcher: (url, options) => {
    if (String(url).startsWith(baseUrl)) return fetch(url, options);
    return Promise.resolve(new Response(String(url).includes('naver.xlsx') ? naver : courier));
  } });
  const created = await handle(event);
  assert.ok(created.files, created.content);
  const bytes = created.files[0].attachment, parsed = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(XLSX.utils.sheet_to_json(parsed.Sheets['발송처리'], { header: 1 }),
    [['상품주문번호', '배송방법', '택배사', '송장번호'], [productId, '택배,등기,소포', '로젠택배', tracking]]);
  const stored = await handle({ ...event, id: '666666666666666666', action: 'download_file', attachments: [] });
  assert.ok(bytes.equals(stored.files[0].attachment));
  assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM invoice_runs').get().n, 1);
  assert.equal(app.locals.db.prepare("SELECT count(*) AS n FROM discord_requests WHERE status = 'succeeded'").get().n, 2);
});

function assignmentServer() {
  const calls = [], groups = [1, 2].map(id => ({ key: `product-${id}`, kind: 'assignment', assignEligible: true,
    itemIds: [id], productOrderIds: [`20261114000000000${id}`], orderId: '202611140000000099', recipient: '검증 수취인',
    productName: '검증 쿠션', optionName: id === 1 ? '높이 13cm' : '높이 15cm', needsSelection: true, mode: null,
    candidates: [{ internalId: 'shipment-13cm', trackingNumber: '45500000001', valid: true },
      { internalId: 'shipment-15cm', trackingNumber: '45500000002', valid: true },
      { internalId: 'old-shipment', trackingNumber: '45500000000', valid: true, selectable: false }] }));
  let revision = 1;
  const view = () => ({ ...detail, viewVersion: String(revision).repeat(64),
    fileActions: { create: !groups.some(group => group.needsSelection), reviewRequired: groups.some(group => group.needsSelection) },
    trackingReview: { groups, pendingCount: groups.filter(group => group.needsSelection).length, replacementCount: 0 } });
  const fetcher = async (url, options = {}) => {
    const route = String(url).replace(config.baseUrl, ''), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, body });
    if (route.startsWith('/api/discord/context?')) return response({ runId: 7, date: event.date });
    if (route === '/api/discord/requests') return response({ request: { ...body, status: 'running' } });
    if (route.startsWith('/api/discord/requests/')) return response({ request: { ...body } });
    if (route === '/api/invoices/7') return response(view());
    if (route === '/api/invoices/7/tracking') {
      assert.equal(body.expectedVersion, view().viewVersion);
      for (const choice of body.choices) Object.assign(groups.find(group => group.key === choice.key),
        { selectedTrackingNumber: choice.trackingNumber, mode: choice.mode, needsSelection: false });
      revision++; return response(view());
    }
    throw new Error('Unexpected assignment route: ' + route);
  };
  return { calls, groups, fetcher, advance() { revision++; } };
}
const discordComponents = output => (output.components || []).flatMap(row => row.components || []);

test('분리 배송은 상품주문번호와 옵션을 구분해 각 송장을 독립 선택한다', async () => {
  const mock = assignmentServer(), handle = createDiscordHandler({ config, fetcher: mock.fetcher });
  const first = await handle({ ...scope, id: '800000000000000001', action: 'show_status', date: event.date });
  const menus = discordComponents(first).filter(component => component.type === 3);
  assert.equal(menus.length, 2);
  for (const [index, menu] of menus.entries()) {
    assert.match(menu.placeholder, new RegExp(mock.groups[index].productOrderIds[0]));
    assert.match(menu.placeholder, index === 0 ? /13cm/ : /15cm/);
    assert.deepEqual(menu.options.map(option => option.value), ['assign:45500000001', 'assign:45500000002']);
  }
  await handle({ ...scope, id: '800000000000000002', buttonId: menus[0].custom_id, values: ['assign:45500000001'] });
  const latest = await handle({ ...scope, id: '800000000000000003', action: 'show_status', date: event.date });
  const second = discordComponents(latest).find(component => component.type === 3 && /15cm/.test(component.placeholder));
  await handle({ ...scope, id: '800000000000000004', buttonId: second.custom_id, values: ['assign:45500000002'] });
  assert.deepEqual(mock.calls.filter(call => call.route.endsWith('/tracking')).map(call => call.body.choices), [
    [{ key: 'product-1', trackingNumber: '45500000001', mode: 'assign' }],
    [{ key: 'product-2', trackingNumber: '45500000002', mode: 'assign' }],
  ]);
  assert.equal(mock.groups[0].selectedTrackingNumber, '45500000001');
  assert.equal(mock.groups[1].selectedTrackingNumber, '45500000002');
  const complete = await handle({ ...scope, id: '800000000000000008', action: 'show_status', date: event.date });
  assert.ok(discordComponents(complete).some(component => component.label === '송장 선택 수정'));
});

test('분리 배송도 변경된 버전과 다른 직원의 선택 버튼을 거부하고 연결 불가 후보는 숨긴다', async () => {
  const mock = assignmentServer(); mock.groups[1].assignEligible = false;
  const otherUser = '777777777777777777';
  const handle = createDiscordHandler({ config: { ...config, userIds: [...config.userIds, otherUser] }, fetcher: mock.fetcher });
  const first = await handle({ ...scope, id: '800000000000000005', action: 'show_status', date: event.date });
  const menus = discordComponents(first).filter(component => component.type === 3);
  assert.equal(menus.length, 1);
  const wrongUser = await handle({ ...scope, userId: otherUser, id: '800000000000000006', buttonId: menus[0].custom_id, values: ['assign:45500000001'] });
  assert.match(wrongUser.content, /계정.*채널/);
  mock.advance();
  const stale = await handle({ ...scope, id: '800000000000000007', buttonId: menus[0].custom_id, values: ['assign:45500000001'] });
  assert.match(stale.content, /바뀌|최신/);
  assert.equal(mock.calls.filter(call => call.route.endsWith('/tracking')).length, 0);
});

test('분리 배송 선택이 여러 건이면 저장한 항목보다 남은 상품주문을 먼저 보여준다', async () => {
  const mock = assignmentServer();
  mock.groups.push({ ...mock.groups[1], key: 'product-3', productOrderIds: ['202611140000000003'], itemIds: [3], optionName: '높이 17cm' });
  const handle = createDiscordHandler({ config, fetcher: mock.fetcher });
  const first = await handle({ ...scope, id: '800000000000000009', action: 'show_status', date: event.date });
  const menu = discordComponents(first).find(component => component.type === 3);
  const next = await handle({ ...scope, id: '800000000000000010', buttonId: menu.custom_id, values: ['assign:45500000001'] });
  const menus = discordComponents(next).filter(component => component.type === 3);
  assert.equal(menus.length, 2);
  assert.ok(menus.some(component => /17cm/.test(component.placeholder)), '미선택 상품주문을 숨기지 않습니다.');
  assert.ok(menus.every(component => !/202611140000000001/.test(component.placeholder)));
});
