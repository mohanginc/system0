import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordHandler } from '../lib/discord-bot.mjs';

const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const config = { secret: 'isolated-tracking-review-secret-32chars', guildId: scope.guildId,
  channelIds: [scope.channelId], userIds: [scope.userId, '444444444444444444'],
  baseUrl: 'http://127.0.0.1:3000', publicOrigin: 'https://system0.example', naverPassword: '' };
const event = { ...scope, id: '555555555555555555', action: 'create_invoice', date: '2026-11-13', attachments: [
  { name: 'naver.xlsx', url: 'https://cdn.discordapp.com/attachments/1/2/naver.xlsx', size: 4 },
  { name: 'courier.xlsx', url: 'https://cdn.discordapp.com/attachments/1/2/courier.xlsx', size: 4 },
] };
const response = data => Response.json(data);
function fixture({ laterOnly = false, reference = false } = {}) {
  const calls = [], progress = [], jobs = new Map(); let revision = 1;
  const group = { key: 'group-one', internalId: '000001', orderId: '202611130000000099', recipient: '가상 수취인',
    itemIds: [1, 2], productOrderIds: ['202611130000000001', '202611130000000002'],
    candidates: [{ trackingNumber: '45500000001', round: 1, printedAt: '10:11:28' },
      { trackingNumber: '45500000002', round: 2, printedAt: '10:28:07' }],
    selectedTrackingNumber: '', mode: null, needsSelection: true,
    replacementEligible: laterOnly, replacementTrackingNumber: laterOnly ? '45500000002' : '' };
  if (reference) {
    Object.assign(group, { kind: 'reprint_reference', replaceEligible: true, splitEligible: false,
      originalTrackingNumber: '45500000001', reprintTrackingNumber: '45500000002' });
    Object.assign(group.candidates[0], { referenceOnly: true, valid: null, selectable: true });
    Object.assign(group.candidates[1], { selectable: true });
  }
  const view = () => ({ run: { id: 7, sourceDate: event.date, savedFileAvailable: false },
    viewVersion: String(revision).repeat(64), currentSummary: { total: 2, ready: group.needsSelection ? 0 : 2, attention: group.needsSelection ? 2 : 0 },
    fileActions: { create: !group.needsSelection, rebuild: false, saved: false, reviewRequired: group.needsSelection },
    items: [], trackingReview: { groups: [group], pendingCount: Number(group.needsSelection), replacementCount: Number(group.replacementEligible) } });
  const fetcher = async (url, options = {}) => {
    const route = String(url).startsWith(config.baseUrl) ? String(url).slice(config.baseUrl.length) : String(url);
    const body = options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : null;
    calls.push({ route, body });
    if (route.startsWith('https:')) return new Response('xlsx');
    if (route.startsWith('/api/discord/context?')) return response({ runId: 7, date: event.date });
    if (route === '/api/discord/requests') {
      if (!jobs.has(body.requestId)) jobs.set(body.requestId, { ...body, status: 'running' });
      return response({ request: jobs.get(body.requestId) });
    }
    if (route.startsWith('/api/discord/requests/')) {
      const request = jobs.get(route.split('/').at(-1)); Object.assign(request, body); return response({ request });
    }
    if (route === '/api/invoices/import' || route === '/api/invoices/7') return response(view());
    if (route === '/api/invoices/check-date') return response({ runIds: [7], summary: { succeeded: 1 }, errors: [] });
    if (route === '/api/invoices/7/tracking') {
      assert.equal(body.expectedVersion, view().viewVersion);
      assert.deepEqual(body.choices, [{ key: group.key, trackingNumber: reference ? '45500000001' : '45500000002', mode: body.choices[0].mode,
        ...(reference ? { acknowledgeOriginal: true } : {}) }]);
      group.selectedTrackingNumber = body.choices[0].trackingNumber; group.mode = body.choices[0].mode;
      group.needsSelection = false; group.replacementEligible = false; revision++;
      return response(view());
    }
    if (route === '/api/invoices/7/file') {
      if (group.needsSelection) return Response.json({ error: '송장 선택이 필요합니다.' }, { status: 409 });
      return new Response('selected-later-xlsx', { headers: { 'Content-Disposition': "attachment; filename*=UTF-8''corrected.xlsx" } });
    }
    throw new Error('Unexpected route: ' + route);
  };
  return { calls, group, view, fetcher, progress, advance: () => { revision++; } };
}
const components = output => (output.components || []).flatMap(row => row.components || []);

test('복수 번호는 자동 파일 요청 없이 해당 출고의 교체·분할 선택을 받고 진행 전에 알린다', async () => {
  const f = fixture(), handle = createDiscordHandler({ config, fetcher: f.fetcher });
  const output = await handle(event, { onProgress: content => { f.progress.push({ content, imported: f.calls.some(c => c.route === '/api/invoices/import') }); } });
  assert.equal(f.calls.some(c => c.route.endsWith('/file')), false);
  assert.equal(output.files, undefined);
  assert.match(output.content, /1.*출고.*선택|선택.*1/);
  const menu = components(output).find(component => component.type === 3);
  assert.ok(menu, '송장 후보 선택 메뉴가 있어야 한다');
  assert.ok(menu.options.some(option => option.value === 'replace:45500000002'));
  assert.ok(menu.options.some(option => option.value === 'split:45500000002'));
  assert.ok(f.progress.length && f.progress[0].imported === false);
});

test('후출력 파일 일괄 교체는 확인 전 변경하지 않고 한 번의 확인으로 공통 API를 호출한다', async () => {
  const f = fixture({ laterOnly: true }), handle = createDiscordHandler({ config, fetcher: f.fetcher });
  const preview = await handle({ ...event, action: 'replace_invoice' });
  assert.equal(f.calls.some(c => c.route.endsWith('/tracking') || c.route.endsWith('/file')), false);
  const button = components(preview).find(component => component.label === '이번 파일의 송장으로 교체');
  assert.ok(button, preview.content);
  const result = await handle({ ...scope, id: '555555555555555556', buttonId: button.custom_id });
  assert.equal(f.group.mode, 'replace'); assert.equal(f.group.selectedTrackingNumber, '45500000002');
  assert.ok(result.files, result.content); assert.equal(result.files[0].name, 'corrected.xlsx');
  assert.equal(f.calls.filter(c => c.route.endsWith('/tracking')).length, 1);
});

test('개별 출고 선택은 선택한 번호와 분할 여부를 저장하고 변경된 작업과 타 직원의 오래된 버튼을 거부한다', async () => {
  const f = fixture(), handle = createDiscordHandler({ config, fetcher: f.fetcher });
  const first = await handle(event), menu = components(first).find(component => component.type === 3);
  assert.ok(menu, first.content);
  const wrongUser = await handle({ ...scope, userId: config.userIds[1], id: '555555555555555557', buttonId: menu.custom_id, values: ['split:45500000002'] });
  assert.equal(f.calls.some(c => c.route.endsWith('/tracking')), false); assert.match(wrongUser.content, /버튼|선택|계정|사용/);
  const selected = await handle({ ...scope, id: '555555555555555558', buttonId: menu.custom_id, values: ['split:45500000002'] });
  assert.equal(f.group.mode, 'split'); assert.equal(selected.files, undefined);
  const build = components(selected).find(component => component.label === '선택 완료 · 엑셀 만들기');
  assert.ok(build, selected.content);
  f.advance();
  const stale = await handle({ ...scope, id: '555555555555555559', buttonId: build.custom_id });
  assert.equal(stale.files, undefined); assert.match(stale.content, /바뀌|최신|변경/);
});

test('일반 추가 업로드의 단일 현재 송장도 실제 분할일 수 있으므로 분할 선택을 숨기지 않는다', async () => {
  const f = fixture({ laterOnly: true });
  const output = await createDiscordHandler({ config, fetcher: f.fetcher })(event);
  const menu = components(output).find(c => c.type === 3);
  assert.ok(menu, output.content);
  assert.ok(menu.options.some(option => option.value === 'split:45500000002'));
});

test('원송장 참조만 있어도 디스코드에서 두 번호 중 실제 라벨을 확인한 원송장을 적용한다', async () => {
  const f = fixture({ reference: true }), handle = createDiscordHandler({ config, fetcher: f.fetcher });
  const output = await handle(event);
  assert.match(output.content, /이번 파일 45500000002 · 원송장 45500000001/);
  const menu = components(output).find(component => component.type === 3);
  assert.deepEqual(menu.options.map(option => option.value), ['original:45500000001', 'replace:45500000002']);
  assert.match(menu.options[0].label, /라벨을 확인한 원송장/);
  const selected = await handle({ ...scope, id: '555555555555555564', buttonId: menu.custom_id, values: ['original:45500000001'] });
  assert.equal(f.group.selectedTrackingNumber, '45500000001');
  const build = components(selected).find(component => component.label === '선택 완료 · 엑셀 만들기');
  const result = await handle({ ...scope, id: '555555555555555565', buttonId: build.custom_id });
  assert.equal(result.files[0].name, 'corrected.xlsx');
  assert.equal(f.calls.find(call => call.route.endsWith('/file')).body.mode, 'export');
});

test('등록 조회와 명시 재생성도 실제 실행 전에 처리 방법을 알린다', async () => {
  for (const action of ['check_registration', 'rebuild_file']) {
    const f = fixture(); f.group.needsSelection = false;
    await createDiscordHandler({ config, fetcher: f.fetcher })({ ...event, action, attachments: [] },
      { onProgress: content => f.progress.push({ content, executed: f.calls.some(c => /check-date|\/file$/.test(c.route)) }) });
    assert.ok(f.progress.length, action); assert.equal(f.progress[0].executed, false);
  }
});

test('저장된 분할 대표를 잘못 고르면 채팅에서 다시 선택할 수 있다', async () => {
  const f = fixture(); f.group.needsSelection = false; f.group.mode = 'split'; f.group.selectedTrackingNumber = '45500000002';
  const handle = createDiscordHandler({ config, fetcher: f.fetcher });
  const status = await handle({ ...event, action: 'show_status', attachments: [] });
  const edit = components(status).find(c => c.label === '송장 선택 수정'); assert.ok(edit, status.content);
  const review = await handle({ ...scope, id: '555555555555555560', buttonId: edit.custom_id });
  assert.ok(components(review).some(c => c.type === 3));
  assert.equal(review.files, undefined);
});
