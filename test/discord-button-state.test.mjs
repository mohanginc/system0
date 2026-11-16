import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordHandler } from '../lib/discord-bot.mjs';

const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const date = '2026-11-16', config = { ...scope, secret: 'isolated-state-buttons-secret-32chars', channelIds: [scope.channelId],
  userIds: [scope.userId], baseUrl: 'http://127.0.0.1:3000', publicOrigin: 'https://system0.example' };
const components = output => (output.components || []).flatMap(row => row.components || []);
const labels = output => components(output).map(component => component.label).filter(Boolean);
const files = output => labels(output).filter(label => /엑셀/.test(label));
function fixture(overrides = {}, { fileStatus = 200, afterFile = {}, afterCheck = {} } = {}) {
  const detail = { run: { id: 7, sourceDate: date, savedFileAvailable: false }, viewVersion: 'a'.repeat(64),
    currentSummary: { total: 18, ready: 18, complete: 0 },
    items: [{ id: 1, decision: 'include', registrationState: 'unchecked', productOrderId: '202611160000000001' }],
    issues: [], trackingReview: { groups: [], pendingCount: 0, replacementCount: 0 },
    fileActions: { create: true, rebuild: false, saved: false, reviewRequired: false, reason: null }, ...overrides };
  const calls = [], jobs = new Map(); let sequence = 555555555555555550n;
  const event = extra => ({ ...scope, id: String(++sequence), action: 'show_status', date, ...extra });
  const handle = createDiscordHandler({ config, fetcher: async (url, options = {}) => {
    const route = String(url).replace(config.baseUrl, ''); calls.push(route);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    if (route.startsWith('https:')) return new Response('xlsx');
    if (route.startsWith('/api/discord/context?')) return Response.json({ runId: 7, date });
    if (route === '/api/discord/requests') {
      if (!jobs.has(body.requestId)) jobs.set(body.requestId, { ...body, status: 'running' });
      return Response.json({ request: jobs.get(body.requestId) });
    }
    if (route.startsWith('/api/discord/requests/')) {
      Object.assign(jobs.get(route.split('/').at(-1)), body); return Response.json({ request: jobs.get(route.split('/').at(-1)) });
    }
    if (route === '/api/invoices/import' || route === '/api/invoices/7') return Response.json(detail);
    if (route === '/api/invoices/check-date') { Object.assign(detail, afterCheck); return Response.json({ runIds: [7], summary: { succeeded: 1 }, errors: [] }); }
    if (route === '/api/invoices/7/file') {
      if (fileStatus !== 200) { Object.assign(detail, afterFile); return Response.json({ error: '검토 내용이 바뀌었습니다.' }, { status: fileStatus }); }
      detail.run.savedFileAvailable = true; detail.run.generatedAt = '2026-11-16T01:00:00Z';
      detail.fileActions = { ...detail.fileActions, saved: true, rebuild: true };
      return new Response('xlsx', { headers: { 'Content-Disposition': 'attachment; filename=result.xlsx' } });
    }
    throw Error('Unexpected route: ' + route);
  } });
  return { detail, calls, event, handle };
}
const blocked = { create: false, rebuild: false, saved: false, reviewRequired: true, reason: '연결이 불명확한 항목을 검토해 주세요.' };
const selection = { groups: [{ key: 'one', recipient: '가상 수취인', internalId: '000001', needsSelection: true,
  candidates: [{ trackingNumber: '45500000001', valid: true }, { trackingNumber: '45500000002', valid: true }] }], pendingCount: 1, replacementCount: 0 };

test('확인 필요 18건에서는 엑셀 생성·다운로드와 무관한 등록 확인을 숨기고 검토를 안내한다', async () => {
  const f = fixture({ currentSummary: { total: 18, ready: 0, attention: 18 }, fileActions: blocked });
  const output = await f.handle(f.event({ action: 'create_invoice', attachments: [
    { name: 'naver.xlsx', size: 4, url: 'https://cdn.discordapp.com/attachments/1/2/naver.xlsx' },
    { name: 'courier.xlsx', size: 4, url: 'https://cdn.discordapp.com/attachments/1/2/courier.xlsx' }] }));
  assert.deepEqual(files(output), []);
  assert.ok(labels(output).includes('system0에서 검토'));
  assert.ok(labels(output).includes('검토 결과 확인'));
  assert.ok(!labels(output).includes('네이버 등록 확인'));
  assert.equal(f.calls.some(route => route.endsWith('/file')), false);
  assert.doesNotMatch(output.content, /엑셀 받기.*눌러/);
});

test('송장 선택 대기는 후보 메뉴를 보여주며 보관 파일이 있어도 새 작업 화면에 파일 버튼을 붙이지 않는다', async () => {
  const f = fixture({ trackingReview: selection, run: { id: 7, sourceDate: date, savedFileAvailable: true },
    fileActions: { ...blocked, saved: true } });
  const output = await f.handle(f.event());
  assert.ok(components(output).some(component => component.type === 3));
  assert.deepEqual(files(output), []);
  assert.ok(!labels(output).includes('네이버 등록 확인'));
});

test('송장 선택을 마쳤어도 다른 충돌이 남으면 엑셀 만들기를 표시하지 않는다', async () => {
  const f = fixture({ fileActions: blocked });
  const output = await f.handle(f.event({ action: 'review_tracking' }));
  assert.deepEqual(files(output), []);
  assert.ok(labels(output).includes('system0에서 검토'));
});

test('네이버 등록 충돌은 파일 대신 검토와 등록 재확인 버튼을 제공한다', async () => {
  const f = fixture({ fileActions: blocked, items: [{ id: 1, decision: 'include', registrationState: 'conflict' }] });
  const output = await f.handle(f.event());
  assert.deepEqual(files(output), []);
  assert.ok(labels(output).includes('네이버 등록 확인'));
});

test('파일 생성 후에는 보관 엑셀과 네이버 확인을 제공하고 불필요한 새 엑셀 버튼은 붙이지 않는다', async () => {
  const f = fixture();
  const output = await f.handle(f.event({ action: 'rebuild_file' }));
  assert.equal(output.files?.length, 1);
  assert.deepEqual(files(output), ['보관 엑셀 받기']);
  assert.ok(labels(output).includes('네이버 등록 확인'));
});

test('모두 등록 완료면 보관 파일을 받을 수 있고 등록 확인과 재생성을 반복 안내하지 않는다', async () => {
  const f = fixture({ run: { id: 7, sourceDate: date, savedFileAvailable: true }, currentSummary: { total: 18, ready: 0, complete: 18 },
    items: [{ id: 1, decision: 'include', registrationState: 'complete', statusFresh: true }],
    fileActions: { create: false, rebuild: true, saved: true, reviewRequired: false, reason: '이미 등록되었습니다.' } });
  const output = await f.handle(f.event());
  assert.deepEqual(files(output), ['보관 엑셀 받기']);
  assert.ok(!labels(output).includes('네이버 등록 확인'));
});

test('파일 요청 중 409로 검토 상태가 바뀌면 최신 상태를 읽어 다운로드 버튼을 제거한다', async () => {
  const f = fixture({}, { fileStatus: 409, afterFile: { fileActions: blocked } });
  const output = await f.handle(f.event({ action: 'rebuild_file' }));
  assert.equal(output.files, undefined);
  assert.deepEqual(files(output), []);
  assert.ok(labels(output).includes('검토 결과 확인'));
  assert.doesNotMatch(output.content, /엑셀 받기.*눌러/);
});

test('다른 처리 내역에서 모두 등록 완료를 확인했다면 과거 작업의 미조회 값으로 재확인을 표시하지 않는다', async () => {
  const f = fixture({ currentSummary: { total: 18, ready: 0, complete: 18 } });
  const output = await f.handle(f.event());
  assert.ok(!labels(output).includes('네이버 등록 확인'));
});

test('이미 처리한 이벤트를 다시 받아도 이전 성공 버튼 대신 현재 검토 상태에 맞춰 표시한다', async () => {
  const f = fixture(), event = f.event(); await f.handle(event);
  f.detail.fileActions = blocked;
  const output = await f.handle(event);
  assert.match(output.content, /이미 처리/);
  assert.deepEqual(files(output), []);
  assert.ok(labels(output).includes('검토 결과 확인'));
});

test('네이버 확인 뒤에도 송장 선택이 남으면 선택 메뉴를 바로 제공한다', async () => {
  const f = fixture({}, { afterCheck: { fileActions: blocked, trackingReview: selection } });
  const output = await f.handle(f.event({ action: 'check_registration' }));
  assert.ok(components(output).some(component => component.type === 3));
  assert.deepEqual(files(output), []);
});
