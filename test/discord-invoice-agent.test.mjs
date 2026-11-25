import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { createDiscordHandler } from '../lib/discord-bot.mjs';
import { courierFile, naverFile, registeredOrder, sourceFile } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), 'absent-system0-' + randomUUID());
process.env.DISCORD_ENV_FILE = path.join(os.tmpdir(), 'absent-discord-' + randomUUID());
const { createApp } = await import('../server.mjs');

const date = '2026-11-16';
const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const config = { secret: 'invoice-agent-local-test-secret', guildId: scope.guildId, channelIds: [scope.channelId],
  userIds: [scope.userId], publicOrigin: 'https://system0.example' };
const order = (n, changes = {}) => ({ productOrderId: '20261116000000000' + n, orderId: '20261116000000009' + n,
  internalId: '00000' + n, trackingNumber: '0455000000' + n, productName: '가상 제품 ' + n, optionName: String(n),
  recipient: '테스트 수취인', phone: '010-0000-0000', address: '서울 검증로 1 101호', quantity: 1, ...changes });
const invoicePath = id => '/api/invoices/' + id;
const tool = (name, args) => [name, args];
const item = (view, product) => view.items.find(row => row.productOrderId === product.productOrderId);
const rows = bytes => XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(bytes), { type: 'buffer' }).Sheets['발송처리'], { header: 1 })
  .slice(1).map(row => [row[0], row[3]]);
const pairs = orders => orders.map(value => [value.productOrderId, value.trackingNumber]);
const components = output => (output.components || []).flatMap(row => row.components || []);
const pendingOrder = order => registeredOrder(order, { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '', deliveryStatus: '' });
const trackingResolution = (order, trackingNumber = order.trackingNumber, mode = 'separate') => ({ productOrderId: order.productOrderId,
  trackingNumber, mode, usedTrackingNumbers: [], unusedTrackingNumbers: [] });

async function boot(t, originalOrders, remoteOrders = originalOrders, { modelClient, model = 'local-mock', remoteOrder = registeredOrder,
  workHistory = false } = {}) {
  const toolRequests = [], webCalls = [], naverCalls = [];
  const byProduct = new Map(remoteOrders.map(value => [value.productOrderId, value]));
  let nextTurn;
  const client = { responses: { create: async request => {
    assert.ok(request.tools?.some(value => value.name === 'read_invoice'), '모델에 공용 업무 도구를 제공해야 합니다.');
    assert.equal(request.store, false);
    const outputs = request.input.filter(entry => entry.type === 'function_call_output').map(entry => JSON.parse(entry.output));
    const sent = JSON.stringify(request.input);
    for (const secret of [config.secret, '테스트 수취인', '010-0000-0000', '서울 검증로 1']) assert.ok(!sent.includes(secret));
    toolRequests.push(request);
    if (modelClient) return modelClient.responses.create(request);
    const next = await nextTurn(outputs);
    if (typeof next === 'string') return { output_text: next,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: next, annotations: [] }] }] };
    const [name, args] = next;
    assert.ok(request.tools.some(value => value.name === name), '테스트 도구가 모델에 선언되어야 합니다.');
    const call_id = 'call_invoice_' + toolRequests.length;
    return { output: [{ type: 'function_call', id: 'fc_' + toolRequests.length, call_id, name, arguments: JSON.stringify(args) }] };
  } } };
  const naver = {
    getProductOrderIds: async orderId => remoteOrders.filter(value => value.orderId === orderId).map(value => value.productOrderId),
    queryProductOrders: async ids => {
      naverCalls.push(ids);
      return ids.map(id => remoteOrder(byProduct.get(id)));
    },
  };
  const discordConfig = workHistory ? { ...config, plainMessageChannelIds: [scope.channelId] } : config;
  const app = createApp({ databasePath: ':memory:', apiKey: '', client, model, discordConfig, naver });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    app.locals.db.close();
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const fetcher = (url, options) => {
    assert.equal(new URL(url).origin, baseUrl, '테스트는 로컬 HTTP만 사용합니다.');
    const call = { route: new URL(url).pathname, method: options?.method || 'GET',
      body: typeof options?.body === 'string' ? JSON.parse(options.body) : undefined };
    webCalls.push(call);
    return fetch(url, options).then(response => { call.status = response.status; return response; });
  };
  const handle = createDiscordHandler({ config: { ...discordConfig, baseUrl }, fetcher });
  let eventId = 555555555555555555n;
  const event = (text, fields) => ({ ...scope, id: String(eventId++), kind: 'message', text, ...fields });
  const run = (message, steps, fields, onProgress) => {
    nextTurn = outputs => {
      const step = steps[outputs.length];
      assert.ok(step, '예상한 도구 호출만 실행합니다.');
      return typeof step === 'function' ? step(outputs.at(-1), outputs) : step;
    };
    return handle(typeof message === 'string' ? event(message, fields) : message, { onProgress });
  };
  const request = async (route, options, expected = 200) => {
    const response = await fetch(baseUrl + route, options);
    assert.equal(response.status, expected, await response.clone().text());
    return response;
  };
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const formFile = (form, key, value) => form.append(key, new Blob([value.buffer]), value.name);
  const source = new FormData();
  formFile(source, 'files', sourceFile(originalOrders));
  const imported = await (await request('/api/import', { method: 'POST', body: source }, 201)).json();
  app.locals.db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(date + 'T01:00:00.000Z', imported.batch.id);
  const start = async (orders, parcels = orders) => {
    const form = new FormData();
    formFile(form, 'naverFiles', naverFile(orders)); formFile(form, 'courierFiles', courierFile(parcels));
    form.append('deliveryCompanyCode', 'KGB'); form.append('sourceDate', date);
    return (await request('/api/invoices/import', { method: 'POST', body: form }, 201)).json();
  };
  const get = async id => (await request(invoicePath(id))).json();
  const save = async (view, changes, issueResolutions = []) => (await request(invoicePath(view.run.id) + '/items',
    json('PATCH', { expectedVersion: view.viewVersion, changes, issueResolutions }))).json();
  const select = async (view, choices) => (await request(invoicePath(view.run.id) + '/tracking',
    json('POST', { expectedVersion: view.viewVersion, choices }))).json();
  const file = async (view, mode) => Buffer.from(await (await request(invoicePath(view.run.id) + '/file',
    json('POST', { expectedVersion: view.viewVersion, mode }))).arrayBuffer());
  const check = () => request('/api/invoices/check-date', json('POST', { date }));
  const setGeneratedAt = (runId, time) => app.locals.db.prepare('UPDATE invoice_runs SET generated_at = ? WHERE id = ?')
    .run(date + 'T' + time + ':00.000Z', runId);
  const setCreatedAt = (runId, time) => app.locals.db.prepare('UPDATE invoice_runs SET created_at = ? WHERE id = ?')
    .run(date + 'T' + time + ':00.000Z', runId);
  return { event, run, start, get, file, select, save, check, request, json, setGeneratedAt, setCreatedAt, webCalls, naverCalls, toolRequests };
}

async function heldAdditionalFileScenario(t, { combined = false, live = false } = {}) {
  const thirteen = order(1, { productName: '가상 쿠션 13cm', optionName: '높이: 13cm', recipient: '가상확인수취인' });
  const fifteen = order(2, { orderId: thirteen.orderId, productName: '가상 쿠션 15cm', optionName: '높이: 15cm', recipient: thirteen.recipient });
  const unknown = { ...thirteen, trackingNumber: '45660001999' };
  const ordinary = Array.from({ length: 25 }, (_, index) => order(index + 3));
  const orders = [thirteen, fifteen, ...ordinary], parcels = [fifteen, thirteen, unknown, ...ordinary];
  const remoteOrder = order => order === thirteen || !combined && order === fifteen ? pendingOrder(order) : registeredOrder(order);
  let modelOptions = {};
  if (live) {
    const { default: OpenAI } = await import('openai');
    const { loadEnvFile } = await import('node:process');
    loadEnvFile(process.env.SYSTEM0_TEST_AGENT_ENV);
    modelOptions = { modelClient: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 35000 }),
      model: process.env.OPENAI_MODEL || 'gpt-6.1-sol' };
  }
  const app = await boot(t, orders, orders, { ...modelOptions, remoteOrder, workHistory: true });
  let view = await app.start(orders, parcels);
  assert.deepEqual(view.manualTracking.groups.map(group => group.productOrderId), [thirteen.productOrderId, fifteen.productOrderId]);
  assert.ok(view.trackingReview.groups.every(group => !group.assignEligible));
  const held = view.items.filter(item => [thirteen.productOrderId, fifteen.productOrderId].includes(item.productOrderId));
  view = await app.save(view, held.map(item => ({ id: item.id, decision: 'hold', note: '확실한 항목부터 파일 생성' })),
    view.issues.filter(issue => issue.reviewRequired && !issue.resolved).map(issue => ({ key: issue.key, note: '실물 확인 대기' })));
  const archive = await app.file(view, 'auto');
  assert.deepEqual(rows(archive), pairs(ordinary));
  const runId = view.run.id;
  const post = async (endpoint, body, status) => (await app.request(invoicePath(runId) + '/' + endpoint,
    app.json('POST', body), status)).json();
  return { app, thirteen, fifteen, unknown, ordinary, runId, archive, post };
}

test('두 상품·세 후보 예외를 대화에서 확정하고 웹과 동일하게 지정 미등록 두 행만 추가한다', async t => {
  const { app, thirteen, fifteen, unknown, ordinary, runId, archive, post } = await heldAdditionalFileScenario(t);
  const ids = [thirteen.productOrderId, fifteen.productOrderId], resolutions = [trackingResolution(thirteen), trackingResolution(fifteen)];
  const original = await app.get(runId);
  const note = `다음처럼 매치해서 가상확인수취인만 있는 네이버 등록 파일을 만들어줘\n${pairs([thirteen, fifteen]).map(pair => pair.join(', ')).join('\n')}`;
  const draft = await app.run(note, [tool('read_invoice', { runId }),
    tool('preview_invoice_tracking_resolution', { runId, resolutions, requestConfirmation: true }), '적용을 확인해 주세요.'],
  { botMessageId: '777777777777777771' });
  assert.match(draft.content, /실제 송장 확정 미리보기/);
  for (const { trackingNumber } of resolutions) assert.ok(draft.content.includes(trackingNumber));
  assert.equal((await app.get(runId)).viewVersion, original.viewVersion);
  assert.equal(draft.files, undefined);
  const webPreview = await post('confirm-tracking', { expectedVersion: original.viewVersion, resolutions, validateOnly: true });
  assert.deepEqual(webPreview.confirmations.map(row => [row.productOrderId, row.trackingNumber]), pairs([thirteen, fifteen]));

  const finished = await app.run('그대로 적용해줘', [tool('read_invoice', { runId }), tool('confirm_invoice_tracking_resolution', { runId }),
    tool('check_invoice_registration', { date }), tool('read_invoice', { runId }),
    tool('create_invoice_export', { runId, mode: 'pending', productOrderIds: ids, validateOnly: false }), '추가 파일 두 건을 만들었습니다.'],
  { botMessageId: '777777777777777772' });
  assert.equal(finished.files?.length, 1, finished.content);
  assert.deepEqual(rows(finished.files[0].attachment), pairs([thirteen, fifteen]));
  const latest = await app.get(runId);
  assert.deepEqual(latest.items.slice(0, 2).map(item => [item.productOrderId, item.trackingNumber]), pairs([thirteen, fifteen]));
  assert.equal(latest.items[0].physicalShipments.find(parcel => parcel.trackingNumber === unknown.trackingNumber).valid, null);
  assert.deepEqual(latest.items.slice(2).map(item => [item.productOrderId, item.trackingNumber]), pairs(ordinary));
  assert.deepEqual(await app.file(latest, 'saved'), archive);
  const webFile = await post('additional-files', { expectedVersion: latest.viewVersion, mode: 'pending', productOrderIds: ids });
  const downloaded = await app.request(invoicePath(runId) + '/additional-files/' + webFile.file.id);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), finished.files[0].attachment);
  assert.equal(app.webCalls.filter(call => call.route.endsWith('/confirm-tracking') && !call.body.validateOnly).length, 1);
  assert.ok(app.webCalls.some(call => call.route.endsWith('/additional-files') && call.body.productOrderIds.join() === ids.join()));
});

async function testCombinedRequest(t, live = false) {
  const { app, thirteen, fifteen, ordinary, runId, archive, post } = await heldAdditionalFileScenario(t, { combined: true, live });
  const ids = [thirteen.productOrderId, fifteen.productOrderId];
  const resolutions = [trackingResolution(thirteen, fifteen.trackingNumber, 'combined'), trackingResolution(fifteen, fifteen.trackingNumber, 'combined')];
  const review = await app.run(`${date} 송장 작업에서 가상확인수취인 13cm와 15cm는 ${fifteen.trackingNumber} 한 상자에 같이 보냈어. `
    + '둘 다 붙인 라벨을 반영하고, 네이버에 아직 안 올린 것만 따로 파일로 줘. 몇 건은 이미 들어가 있는지도 알려줘.', [
    tool('read_invoice', { runId }),
    tool('find_invoice_items', { runId, recipient: thirteen.recipient, product: null, productOrderIds: [] }),
    output => {
      assert.deepEqual(output.items.map(item => item.productOrderId), ids);
      return tool('preview_invoice_tracking_resolution', { runId, resolutions, requestConfirmation: true });
    }, '합포장 확인 후 파일을 만들겠습니다.',
  ], { botMessageId: '777777777777777773' });
  assert.match(review.content, /실제 송장 확정 미리보기/, review.content);
  const completed = await app.run('좋아, 그대로 진행해줘', [
    tool('read_invoice', { runId }), tool('check_invoice_registration', { date }),
    output => {
      assert.equal(output.confirmationRequired, true);
      return tool('confirm_invoice_tracking_resolution', { runId });
    }, tool('check_invoice_registration', { date }),
    tool('read_invoice', { runId }), tool('create_invoice_export', { runId, mode: 'pending', productOrderIds: ids, validateOnly: false }),
    '1건은 등록 완료입니다.',
  ], { botMessageId: '777777777777777774' });
  if (live) t.diagnostic(app.webCalls.filter(call => call.route.startsWith('/api/invoices')).map(call => `${call.method} ${call.route} ${call.status}`).join(' | '));
  assert.equal(completed.files?.length, 1, completed.content);
  assert.deepEqual(rows(completed.files[0].attachment), [[thirteen.productOrderId, fifteen.trackingNumber]]);
  const latest = await app.get(runId);
  assert.equal(item(latest, fifteen).registrationState, 'complete');
  assert.equal(item(latest, thirteen).registrationState, 'pending');
  assert.deepEqual(await app.file(latest, 'saved'), archive);
  if (!live) {
    const blocked = await app.run(`전체 파일 말고 ${thirteen.productOrderId} 한 건만 보낼 엑셀을 만들어줘.`, [tool('read_invoice', { runId }),
      tool('get_invoice_file', { runId, mode: 'export' }), output => {
        assert.equal(output.ok, false);
        return tool('create_invoice_export', { runId, mode: 'all', productOrderIds: null, validateOnly: false });
      }, output => {
        assert.equal(output.confirmationRequired, true);
        return '범위를 확인해 주세요.';
      }]);
    assert.equal(blocked.files, undefined);
    assert.match(blocked.content, /전체 엑셀 범위 확인/);
    const expansion = await app.run(`${thirteen.productOrderId}의 등록 상태를 보고 이 송장 작업을 한 파일로 묶어줘.`, [
      tool('read_invoice', { runId }), tool('create_invoice_export', { runId, mode: 'all', productOrderIds: null, validateOnly: false }),
      '상품주문은 발송 대기입니다.',
    ], { botMessageId: '777777777777777775' });
    assert.equal(expansion.files, undefined);
    assert.match(expansion.content, /27건/);
    const approved = await app.run('그대로 생성해줘', [tool('read_invoice', { runId }),
      tool('create_invoice_export', { runId, mode: 'all', productOrderIds: null, validateOnly: false }), '전체 엑셀입니다.',
    ], { botMessageId: '777777777777777776' });
    assert.equal(rows(approved.files[0].attachment).length, 27);
  }
  const full = await app.run(`${date} 송장 작업의 등록 완료분까지 포함해 전체 확인용 엑셀도 별도로 줘.`, [
    tool('read_invoice', { runId }), tool('create_invoice_export', { runId, mode: 'all', productOrderIds: null, validateOnly: false }), '전체 확인용입니다.',
  ]);
  assert.equal(full.files?.length, 1, full.content);
  assert.deepEqual(rows(full.files[0].attachment), [[thirteen.productOrderId, fifteen.trackingNumber], ...pairs([fifteen, ...ordinary])]);
  const fromWeb = await post('additional-files', { expectedVersion: latest.viewVersion, mode: 'all', productOrderIds: null });
  const saved = await app.request(invoicePath(runId) + '/additional-files/' + fromWeb.file.id);
  assert.deepEqual(Buffer.from(await saved.arrayBuffer()), full.files[0].attachment);
}

test('수취인·상품으로 찾은 합포장 확정과 등록 조회, 미등록 추가 파일과 전체 파일을 조합한다', async t => {
  await testCombinedRequest(t);
});

test('실제 모델이 가상 주문의 합포장·조회·추가 파일 요청에 도구를 조합한다', { skip: !process.env.SYSTEM0_TEST_AGENT_ENV, timeout: 180000 }, async t => {
  await testCombinedRequest(t, true);
});

test('날짜·수취인·원송장으로 지정한 한 건만 선택창에 표시하고 다른 미선택 출고를 적용하지 않는다', async t => {
  const a = order(1, { recipient: '이테스트', trackingNumber: '99000014043' });
  const orders = [a, ...[2, 3, 4].map(index => order(index, { recipient: `가상 수취인 ${index}` }))];
  const reprints = orders.map((product, index) => ({ ...product, originalTrackingNumber: product.trackingNumber,
    trackingNumber: String(99000015043 + index), issueCount: 2, printedAt: '16:28:17' }));
  const s = await boot(t, orders);
  const previous = await s.start(orders.slice(1), reprints.slice(1));
  const started = await s.start(orders, reprints), runId = started.run.id;
  const last = started.trackingReview.groups.find(group => group.productOrderIds.includes(orders[3].productOrderId));
  await s.select(started, [{ key: last.key, mode: 'replace', trackingNumber: reprints[3].trackingNumber }]);
  const before = await s.get(runId), target = before.trackingReview.groups.find(group => group.productOrderIds.includes(a.productOrderId));
  assert.equal(before.trackingReview.pendingCount, 3);
  const requested = `23일 송장에서 ${a.recipient} 송장을 ${a.trackingNumber}으로 바꿔줘`;
  const output = await s.run(requested, [
    tool('list_invoice_runs', { date }),
    tool('read_invoice', { runId: previous.run.id }),
    tool('read_invoice', { runId }),
    tool('review_invoice_tracking', { runId, bulkReplacement: false }),
    result => { assert.equal(result.trackingRows.length, 1); return '실제 상자에 붙은 라벨을 확인해 선택해 주세요.'; },
  ]);
  const menus = components(output).filter(component => component.type === 3);
  assert.equal(menus.length, 1, output.content);
  assert.ok(output.content.includes(`${a.recipient} (${a.productOrderId})`), output.content);
  assert.equal(menus[0].placeholder, `${a.recipient} 적용 송장 선택`);
  assert.deepEqual(menus[0].options.map(option => option.value), [`original:${a.trackingNumber}`, `replace:${reprints[0].trackingNumber}`]);
  assert.equal(components(output).some(component => component.label === '이번 파일의 송장으로 교체'), false);
  assert.equal(s.webCalls.filter(call => call.route.endsWith('/tracking')).length, 0);
  const sourceMessageId = '900000000000000028';
  const staged = await s.run('', [], { kind: 'component', sourceMessageId, buttonId: menus[0].custom_id, values: [`original:${a.trackingNumber}`] });
  assert.equal(components(staged).filter(component => component.type === 3).length, 1);
  const apply = components(staged).find(component => component.label === '선택 적용');
  assert.ok(apply, staged.content); assert.equal(Boolean(apply.disabled), false);
  const applied = await s.run('', [], { kind: 'component', sourceMessageId, buttonId: apply.custom_id });
  assert.equal(applied.files, undefined);
  const writes = s.webCalls.filter(call => call.route.endsWith('/tracking'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.choices, [{ key: target.key, trackingNumber: a.trackingNumber, mode: 'replace', acknowledgeOriginal: true }]);
  const after = await s.get(runId);
  assert.equal(item(after, a).trackingNumber, a.trackingNumber);
  assert.equal(after.trackingReview.pendingCount, 2);
  assert.deepEqual(after.items.filter(value => value.productOrderId !== a.productOrderId), before.items.filter(value => value.productOrderId !== a.productOrderId));
  assert.equal(components(applied).filter(component => component.type === 3).length, 0);

  for (const text of [
    `상품주문번호 ${a.productOrderId}의 송장을 ${reprints[1].trackingNumber}로 바꿔줘`,
    `없는고객 송장을 ${reprints[1].trackingNumber}으로 바꿔줘`,
  ]) {
    const rejected = await s.run(text, [tool('read_invoice', { runId }), tool('review_invoice_tracking', { runId, bulkReplacement: false }),
      result => { assert.equal(result.ok, false); return '변경 대상을 확인해 주세요.'; }]);
    assert.equal(components(rejected).some(component => component.type === 3), false);
  }
  assert.equal(s.webCalls.filter(call => call.route.endsWith('/tracking')).length, 1);
  assert.equal((await s.get(runId)).viewVersion, after.viewVersion);
});

test('상품주문번호로 찾은 분리 배송 건을 비교·정정·재조회하면 웹에도 같은 상품만 변경됩니다', async t => {
  const a = order(1), b = order(2, { orderId: a.orderId });
  const s = await boot(t, [a, b]);
  const start = await s.start([a, b]);
  const runId = start.run.id;
  const choice = (product, number) => ({ key: start.trackingReview.groups.find(g => g.productOrderIds.includes(product.productOrderId)).key,
    trackingNumber: number, mode: 'assign' });
  await s.select(start, [choice(a, b.trackingNumber), choice(b, a.trackingNumber)]);
  await s.check();
  const originalSibling = item(await s.get(runId), b);
  const output = await s.run(a.productOrderId + '번 송장 비교하고 ' + a.trackingNumber + '로 고친 뒤 다시 조회해줘', [
    tool('find_invoice_order', { productOrderId: a.productOrderId }),
    result => { assert.equal(result.matches[0].runId, runId); return tool('read_invoice', { runId: result.matches[0].runId }); },
    result => {
      assert.equal(item(result, a).trackingNumber, b.trackingNumber);
      assert.equal(item(result, a).naverRegistration.trackingNumber, a.trackingNumber);
      assert.equal(item(result, a).naverRegistration.matches, false);
      return tool('select_invoice_tracking', { runId, productOrderId: a.productOrderId, trackingNumber: a.trackingNumber, mode: 'assign' });
    },
    result => { assert.equal(result.ok, true); return tool('check_invoice_registration', { date }); },
    result => { assert.equal(result.ok, true); return tool('read_invoice', { runId }); },
    result => { assert.equal(item(result, a).naverRegistration.matches, true); return '정정한 송장으로 등록을 확인했습니다.'; },
  ]);
  assert.match(output.content, /정정한 송장/);
  const current = await s.get(runId);
  assert.equal(item(current, a).trackingNumber, a.trackingNumber);
  assert.equal(item(current, a).naverRegistration.matches, true);
  assert.equal(item(current, b).trackingNumber, originalSibling.trackingNumber);
  assert.equal(item(current, b).naverRegistration.matches, false);
  assert.equal(s.naverCalls.length, 2, '웹 조회와 봇 재조회가 같은 거래 조회 경로를 거칩니다.');
  assert.deepEqual(s.webCalls.filter(call => call.method === 'POST' && call.route === invoicePath(runId) + '/tracking')
    .map(call => call.body.validateOnly === true), [true, false]);
});

test('네이버 발송 대상 밖의 같은 출고 건은 저장 주문과 로젠 원본 위치를 한 항목에 보여줍니다', async t => {
  const naverOrder = order(1);
  const outside = order(2, { orderId: '20261116-0000002', productName: '[coupang] 가상 제품 2', recipient: '가상참고인' });
  const courierOnly = order(3, { internalId: '', recipient: '가상택배인' });
  const unnamed = order(4, { internalId: '', recipient: '' });
  const s = await boot(t, [naverOrder, outside], [naverOrder]);
  const before = await s.start([naverOrder], [naverOrder, outside, courierOnly, unnamed]), runId = before.run.id;
  assert.equal(before.currentOutsideOrders.find(row => row.orderId === outside.orderId)?.internalId, outside.internalId);
  assert.equal(before.unmatchedCouriers.find(row => row.trackingNumber === outside.trackingNumber)?.internalId, outside.internalId);

  const output = await s.run(`${date} 네이버 등록 상태를 조회하고 참고할 출고는 어느 파일에서 찾았는지 쉽게 알려줘`, [
    tool('check_invoice_registration', { date }),
    result => { assert.deepEqual(result.runIds, [runId]); return tool('read_invoice', { runId }); },
    result => {
      const notes = result.sourceNotes.filter(note => note.orderId === outside.orderId || note.trackingNumbers.includes(outside.trackingNumber));
      assert.equal(notes.length, 1, '같은 내부 출고는 보고에 한 번만 들어갑니다.');
      const [note] = notes;
      assert.equal(note.orderId, outside.orderId);
      assert.deepEqual(note.trackingNumbers, [outside.trackingNumber]);
      assert.deepEqual(note.savedOrderSource, { file: '가상_확인주문.xlsx', row: 3 });
      assert.deepEqual(note.courierSources, [{ file: '가상_월요일_로젠송장.xlsx', row: 3, trackingNumber: outside.trackingNumber }]);
      assert.equal(note.registration, '이번 네이버 발송 대상에 없어 등록 여부는 조회하지 않았습니다.');
      const { file, row, trackingNumber } = note.courierSources[0];
      return `저장 주문 엑셀 ${note.savedOrderSource.file} ${note.savedOrderSource.row}행의 체결번호 ${note.orderId}와 `
        + `로젠 송장 엑셀 ${file} ${row}행의 송장번호 ${trackingNumber}는 같은 출고 건입니다. ${note.registration}\n`
        + `택배 엑셀에만 있는 송장 \`${courierOnly.trackingNumber}\`, \`${unnamed.trackingNumber}\``;
    },
  ]);
  assert.match(output.content, /저장 주문 엑셀.*3행의 체결번호.*로젠 송장 엑셀.*3행의 송장번호.*같은 출고 건/);
  assert.match(output.content, /등록 여부는 조회하지 않았습니다/);
  assert.ok(output.content.includes(`가상참고인 (${outside.orderId})`));
  assert.ok(output.content.includes(`가상택배인 (\`${courierOnly.trackingNumber}\`), \`${unnamed.trackingNumber}\``));
  assert.ok(s.toolRequests.every(request => !/가상참고인|가상택배인/.test(JSON.stringify(request.input))));
  assert.deepEqual(s.naverCalls.flat(), [naverOrder.productOrderId]);
});

test('조회와 대화에서 확인한 송장 작업은 날짜 링크로 표시하고 임의 작업번호는 가립니다', async t => {
  const a = order(1), s = await boot(t, [a]);
  const before = await s.start([a]), runId = before.run.id;
  s.setCreatedAt(runId, '00:52');
  await s.file(await s.get(runId), 'export');
  const output = await s.run(`${date} 네이버 송장 등록 상태를 알려줘`, [
    tool('check_invoice_registration', { date }),
    result => {
      assert.deepEqual(result.runIds, [runId]);
      return `송장 작업 #${runId}에서 등록을 확인했습니다.\n`
        + `송장 작업 \`#${runId}\`의 내역과 송장 작업 **#${runId}**의 번호입니다.\n`
        + `주문 작업 #${runId}와 확인되지 않은 송장 작업 #99999는 참조 번호입니다.`;
    },
  ]);
  const workLink = `[11월 16일 오전 송장 작업](https://system0.example/invoices.html?run=${runId})`;
  assert.ok(output.content.includes(`${workLink}에서 등록을 확인했습니다.`), output.content);
  assert.ok(output.content.includes(`${workLink}의 내역과 ${workLink}의 번호입니다.`), output.content);
  assert.ok(output.content.includes(`주문 작업 #${runId}와 확인되지 않은 송장 작업은`), output.content);
  assert.doesNotMatch(output.content, /#99999/);
  await s.run('보관 엑셀을 다시 보내줘', [tool('read_invoice', { runId }), tool('get_invoice_file', { runId, mode: 'saved' }), '보관 엑셀입니다.']);
  const recommendation = await s.run('오늘 할 일 추천해줘', [`송장 작업 #${runId}의 등록 상태를 확인해 주세요.`]);
  assert.ok(recommendation.content.includes(workLink), recommendation.content);
  assert.doesNotMatch(recommendation.content, /#\d+/);
});

test('누락을 확인해 보류·제외 사유를 저장하고 남은 주문만 웹과 같은 업로드 엑셀에 담습니다', async t => {
  const ready = order(1), hold = order(2, { recipient: '가상보류인' }), exclude = order(3, { recipient: '가상제외인' });
  const s = await boot(t, [ready]);
  const before = await s.start([ready, hold, exclude], [ready]), runId = before.run.id;
  const decisions = [
    { productOrderId: hold.productOrderId, decision: 'hold', note: '송장 누락' },
    { productOrderId: exclude.productOrderId, decision: 'exclude', note: '별도 처리' },
  ];
  const output = await s.run('작업 ' + runId + ' 확인해서 ' + hold.productOrderId + ' 송장 누락으로 보류하고 '
    + exclude.productOrderId + ' 별도 처리로 제외한 뒤 남은 업로드용 엑셀만 줘', [
    tool('read_invoice', { runId }),
    result => {
      const missing = result.issues.filter(issue => issue.kind === 'missing_saved_order');
      assert.equal(missing.length, 2);
      return tool('save_invoice_review', { runId, changes: decisions, warnings: [] });
    },
    result => { assert.equal(result.ok, true); return tool('read_invoice', { runId }); },
    result => { assert.equal(item(result, hold).decision, 'hold'); return tool('get_invoice_file', { runId, mode: 'export' }); },
    result => { assert.equal(result.ok, true); return `남은 주문의 업로드용 엑셀입니다. ${hold.productOrderId} 보류, ${exclude.productOrderId} 제외.`; },
  ]);
  assert.equal(output.files?.length, 1, output.content);
  assert.ok(output.content.includes(`가상보류인 (${hold.productOrderId})`));
  assert.ok(output.content.includes(`가상제외인 (${exclude.productOrderId})`));
  const view = await s.get(runId);
  for (const decision of decisions) {
    const saved = item(view, decision);
    assert.equal(saved.decision, decision.decision); assert.equal(saved.note, decision.note);
  }
  assert.deepEqual(rows(output.files[0].attachment), pairs([ready]));
  assert.deepEqual(await s.file(view, 'saved'), output.files[0].attachment);
  assert.deepEqual(s.webCalls.filter(call => call.method === 'PATCH' && call.route === invoicePath(runId) + '/items')
    .map(call => call.body.validateOnly === true), [true, false]);
});

test('네이버 원본과 이름이 달라도 웹 표시 이름으로 보고하고 다음 모델 요청의 대화에는 덧붙인 이름을 넣지 않는다', async t => {
  const saved = order(1, { recipient: '가상화면수취인' });
  const naverOrder = { ...saved, recipient: '가상네이버수취인' };
  const s = await boot(t, [saved], [naverOrder]);
  const view = await s.start([naverOrder], [saved]), runId = view.run.id;
  const row = view.currentOrders.find(order => order.itemIds.includes(item(view, saved).id));
  assert.equal(row.recipient, saved.recipient);
  assert.equal(item(view, saved).recipient, naverOrder.recipient);
  const id = saved.productOrderId, botMessageId = '777777777777777111';
  const first = await s.run(`송장 작업 #${runId} 확인이 필요한 상품을 알려줘`, [
    tool('read_invoice', { runId }),
    () => `확인 필요\n|상품주문번호|상태|\n|---|---|\n|\`${id}\`|확인 필요|\nhttps://example.test/orders/${id}`,
  ], { botMessageId });
  assert.ok(first.content.includes(`|${saved.recipient} (\`${id}\`)|확인 필요|`), first.content);
  assert.ok(first.content.includes(`https://example.test/orders/${id}`));
  assert.ok(!first.content.includes(naverOrder.recipient));
  const next = await s.run('이전 확인 항목을 짧게 정리해줘', [
    tool('read_invoice', { runId }),
    () => `확인 필요 ${id}`,
  ], { replyToId: botMessageId, botMessageId: '777777777777777112' });
  assert.ok(next.content.includes(`${saved.recipient} (${id})`), next.content);
  const modelInputs = JSON.stringify(s.toolRequests.map(request => request.input));
  assert.ok(modelInputs.includes('conversation'), '후속 요청에서 보관 대화도 검증합니다.');
  assert.ok(!modelInputs.includes(saved.recipient));
  assert.ok(!modelInputs.includes(naverOrder.recipient));
  assert.ok(!first.content.includes(saved.phone) && !first.content.includes(saved.address));
});

test('날짜에서 두 작업을 찾고 오전 보관본과 오후 최신 매칭 재생성 파일을 각각 반환합니다', async t => {
  const a = order(1), b = order(2);
  const s = await boot(t, [a, b]);
  const first = await s.start([a]), savedFirst = await s.file(first, 'export');
  const second = await s.start([b], [{ ...b, round: 1 }, { ...b, trackingNumber: '04550000009', round: 2 }]);
  const group = second.trackingReview.groups[0];
  const select = (view, trackingNumber) => s.select(view, [{ key: group.key, trackingNumber, mode: 'split' }]);
  const selected = await select(second, b.trackingNumber);
  const savedSecond = await s.file(selected, 'export');
  const changedNumber = '04550000009';
  const changed = await select(await s.get(second.run.id), changedNumber);
  const webRebuilt = await s.file(changed, 'rebuild');
  s.setGeneratedAt(first.run.id, '01:00');
  s.setGeneratedAt(second.run.id, '06:00');
  s.setCreatedAt(first.run.id, '00:52');
  s.setCreatedAt(second.run.id, '05:09');
  const progress = [];
  const output = await s.run(date + ' 오전 작업은 보관본으로, 오후 작업은 현재 값으로 다시 만들어줘', [
    tool('list_invoice_runs', { date }),
    result => {
      const morning = result.runs.find(run => run.generatedAt?.includes('T01:00'));
      assert.equal(morning.runId, first.run.id);
      return tool('read_invoice', { runId: morning.runId });
    },
    tool('get_invoice_file', { runId: first.run.id, mode: 'saved' }),
    (_result, outputs) => {
      const afternoon = outputs[0].runs.find(run => run.generatedAt?.includes('T06:00'));
      assert.equal(afternoon.runId, second.run.id);
      return tool('read_invoice', { runId: afternoon.runId });
    },
    result => { assert.equal(item(result, b).trackingNumber, changedNumber); return tool('get_invoice_file', { runId: second.run.id, mode: 'rebuild' }); },
    result => { assert.equal(result.ok, true); return '선택한 두 파일입니다.'; },
  ], undefined, message => progress.push(message));
  assert.equal(output.files?.length, 2, output.content);
  for (const [run, time] of [[first, '오전 9:52'], [second, '오후 2:09']]) {
    const link = `[11월 16일 ${time} 송장 작업](https://system0.example/invoices.html?run=${run.run.id})`;
    assert.ok(output.content.includes(link), output.content);
    assert.ok(progress.some(message => message.includes(link)));
  }
  assert.doesNotMatch([...progress, output.content].join('\n'), /#\d+/);
  assert.deepEqual(output.files.map(file => file.name), ['네이버_발송처리_2026-11-16_0952.xlsx', '네이버_발송처리_2026-11-16_1409_현재매칭재생성.xlsx']);
  assert.deepEqual(output.files[0].attachment, savedFirst);
  assert.deepEqual(rows(output.files[1].attachment), rows(webRebuilt));
  assert.deepEqual(rows(output.files[1].attachment), [[b.productOrderId, changedNumber]]);
  assert.deepEqual(await s.file(await s.get(second.run.id), 'saved'), savedSecond);
});

test('한 요청에서 기존 파일을 받고 보류를 저장한 뒤 남은 건의 새 엑셀을 생성합니다', async t => {
  const a = order(1), b = order(2), s = await boot(t, [a, b]);
  const initial = await s.start([a, b]), runId = initial.run.id, archived = await s.file(initial, 'export');
  const event = s.event('먼저 ' + b.productOrderId + '의 작업을 찾아 보관 엑셀을 줘. 그 다음 그 주문에 샘플 확인이라고 남기고 보류해서 발송용도 별도로 줘');
  const output = await s.run(event, [
    tool('find_invoice_order', { productOrderId: b.productOrderId }),
    result => tool('read_invoice', { runId: result.matches[0].runId }),
    tool('get_invoice_file', { runId, mode: 'saved' }),
    result => {
      assert.equal(result.ok, true);
      return tool('save_invoice_review', { runId, changes: [{ productOrderId: b.productOrderId, decision: 'hold', note: '샘플 확인' }], warnings: [] });
    },
    tool('read_invoice', { runId }),
    result => { assert.equal(item(result, b).hasReviewNote, true); return tool('get_invoice_file', { runId, mode: 'export' }); },
    result => { assert.equal(result.ok, true); return '보관본과 남은 건의 새 파일입니다.'; },
  ]);
  assert.equal(output.files?.length, 2, output.content);
  assert.deepEqual(output.files[0].attachment, archived);
  assert.deepEqual(rows(output.files[1].attachment), pairs([a]));
  const current = await s.get(runId);
  assert.equal(item(current, b).decision, 'hold');
  assert.equal(item(current, b).note, '샘플 확인');
  const replay = await s.run(event, []);
  assert.match(replay.content, /이미 처리/);
  assert.equal((await s.get(runId)).viewVersion, current.viewVersion);
  assert.deepEqual(await s.file(current, 'saved'), archived);
});

test('읽은 뒤 웹에서 고친 검토는 봇이 덮어쓰지 못하고 미등록 직원은 모델도 호출하지 않습니다', async t => {
  const a = order(1), s = await boot(t, [a]);
  const before = await s.start([a]), runId = before.run.id;
  const output = await s.run(a.productOrderId + '은 봇 메모로 보류해줘', [
    tool('read_invoice', { runId }),
    async result => {
      assert.equal(result.ok, true);
      await s.save(before, [{ id: before.items[0].id, decision: 'include', note: '웹에서 먼저 기록' }]);
      return tool('save_invoice_review', { runId, changes: [{ productOrderId: a.productOrderId, decision: 'hold', note: '봇 메모' }], warnings: [] });
    },
  ]);
  assert.match(output.content, /바뀌었습니다/);
  assert.ok(s.webCalls.some(call => call.method === 'PATCH' && call.route === invoicePath(runId) + '/items' && call.status === 409));
  const saved = item(await s.get(runId), a);
  assert.equal(saved.decision, 'include'); assert.equal(saved.note, '웹에서 먼저 기록');
  const count = s.toolRequests.length;
  const unauthorized = await s.run('송장 검토 상태를 바꿔줘', [], { userId: '444444444444444444' });
  assert.match(unauthorized.content, /권한/);
  assert.equal(s.toolRequests.length, count);
});

test('모델이 사용자가 적은 것과 다른 상품주문을 보류하려 하면 저장하지 않습니다', async t => {
  const a = order(1), b = order(2), s = await boot(t, [a, b]);
  const work = await s.start([b]), runId = work.run.id;
  const output = await s.run('상품주문번호 ' + a.productOrderId + '을 보류해줘', [
    tool('read_invoice', { runId }),
    tool('save_invoice_review', { runId, changes: [{ productOrderId: b.productOrderId, decision: 'hold', note: null }], warnings: [] }),
    result => { assert.equal(result.ok, false); return result.error; },
  ]);
  assert.match(output.content, /지정된 상품주문/);
  assert.equal(item(await s.get(runId), b).decision, 'include');
  assert.ok(!s.webCalls.some(call => call.method === 'PATCH' && call.route.endsWith('/items')));
});

test('공용 API의 검토 사전 확인이 실패하면 실제 저장 없이 이유를 보고합니다', async t => {
  const ready = order(1), missing = order(2), s = await boot(t, [ready]);
  const before = await s.start([ready, missing], [ready]), runId = before.run.id;
  const output = await s.run(`작업 #${runId}에서 상품주문번호 ${missing.productOrderId}를 포함해줘`, [
    tool('read_invoice', { runId }),
    tool('save_invoice_review', { runId, changes: [{ productOrderId: missing.productOrderId, decision: 'include', note: null }], warnings: [] }),
    result => { assert.equal(result.ok, false); return '포함해 저장했습니다.'; },
  ]);
  assert.match(output.content, /연결 근거|해결하지 않은 경고/);
  assert.doesNotMatch(output.content, /포함해 저장했습니다/);
  const calls = s.webCalls.filter(call => call.method === 'PATCH' && call.route === invoicePath(runId) + '/items');
  assert.deepEqual(calls.map(call => [call.body.validateOnly, call.status]), [[true, 400]]);
  assert.equal((await s.get(runId)).viewVersion, before.viewVersion);
});

test('보류 저장 뒤 엑셀 사전 확인이 막히면 완료한 저장과 남은 충돌을 웹 작업 링크와 구분합니다', async t => {
  const hold = order(1), ready = order(2), missing = order(3), s = await boot(t, [hold, ready]);
  const before = await s.start([hold, ready, missing], [hold, ready]), runId = before.run.id;
  assert.equal(before.fileActions.create, false);
  const progress = [];
  const output = await s.run(`작업 #${runId}에서 ${hold.productOrderId}는 '별도 확인'으로 보류하고 남은 건의 엑셀을 만들어줘`, [
    tool('read_invoice', { runId }),
    tool('save_invoice_review', { runId, changes: [{ productOrderId: hold.productOrderId, decision: 'hold', note: '별도 확인' }], warnings: [] }),
    result => { assert.equal(result.ok, true); return tool('get_invoice_file', { runId, mode: 'export' }); },
    result => { assert.equal(result.ok, false); return '모든 작업과 엑셀 생성이 끝났습니다.'; },
  ], undefined, async message => {
    progress.push(message);
    const reviewCalls = s.webCalls.filter(call => call.method === 'PATCH' && call.route === invoicePath(runId) + '/items');
    assert.deepEqual(reviewCalls.map(call => [call.body.validateOnly, call.status]), [[true, 200]]);
    assert.equal((await s.get(runId)).viewVersion, before.viewVersion);
  });
  assert.equal(progress.length, 1);
  assert.match(progress[0], /검토|보류/);
  assert.match(output.content, /\*\*완료\*\*\n- 검토 저장/);
  assert.match(output.content, /\*\*미완료\*\*/);
  assert.ok(output.content.includes(before.fileActions.reason), output.content);
  assert.match(output.content, new RegExp(`\\[11월 16일 (?:오전 |오후 )?송장 작업\\]\\(https://system0\\.example/invoices\\.html\\?run=${runId}\\)`));
  assert.doesNotMatch(output.content, /모든 작업과 엑셀 생성이 끝났습니다/);
  assert.equal(output.files?.length ?? 0, 0);
  assert.ok(!s.webCalls.some(call => call.method === 'POST' && call.route === invoicePath(runId) + '/file'));
  const after = await s.get(runId);
  assert.equal(item(after, hold).decision, 'hold');
  assert.equal(item(after, hold).note, '별도 확인');
  assert.equal(after.run.savedFileAvailable, false);
});

test('웹에서만 할 수 있는 원본 위치 열기는 확인한 작업의 링크를 넘깁니다', async t => {
  const a = order(1), s = await boot(t, [a]);
  const before = await s.start([a]), runId = before.run.id;
  const output = await s.run(`작업 #${runId}의 원본 엑셀 행 위치를 열어줘`, [
    tool('read_invoice', { runId }),
    tool('handoff_invoice_to_web', { runId, task: 'original_location' }),
    () => '원본 위치는 웹에서 확인할 수 있습니다.',
  ]);
  assert.match(output.content, /원본.*위치/);
  assert.match(output.content, new RegExp(`\\[11월 16일 (?:오전 |오후 )?송장 작업\\]\\(https://system0\\.example/invoices\\.html\\?run=${runId}\\)`));
  assert.ok(!s.webCalls.some(call => call.route.startsWith(invoicePath(runId) + '/') && call.method !== 'GET'));
  assert.equal((await s.get(runId)).viewVersion, before.viewVersion);
});

test('후보가 아닌 송장은 직접 이유를 보고하고 웹 이동으로 문제를 대신하지 않습니다', async t => {
  const a = order(1), s = await boot(t, [a]);
  const before = await s.start([a], [{ ...a, round: 1 }, { ...a, trackingNumber: '04550000009', round: 2 }]);
  const runId = before.run.id, invalidNumber = '04550000099';
  const output = await s.run(`작업 #${runId}에서 상품주문번호 ${a.productOrderId}의 대표 송장을 ${invalidNumber}번으로 바꿔줘`, [
    tool('read_invoice', { runId }),
    tool('select_invoice_tracking', { runId, productOrderId: a.productOrderId, mode: 'split', trackingNumber: invalidNumber }),
    result => { assert.equal(result.ok, false); return '송장을 바꿨습니다.'; },
  ]);
  assert.match(output.content, /유효 송장 후보/);
  assert.doesNotMatch(output.content, /웹에서 작업 열기|송장을 바꿨습니다/);
  assert.ok(!s.webCalls.some(call => call.route === invoicePath(runId) + '/tracking'));
  assert.equal((await s.get(runId)).viewVersion, before.viewVersion);
});

test('같은 날짜에 후보 작업이 둘이면 웹 링크를 붙이지 않고 대상만 확인합니다', async t => {
  const a = order(1), b = order(2), s = await boot(t, [a, b]);
  const first = await s.start([a]);
  await s.file(first, 'export');
  const second = await s.start([b]);
  await s.file(second, 'export');
  s.setGeneratedAt(first.run.id, '01:00');
  s.setGeneratedAt(second.run.id, '02:00');
  const output = await s.run(`${date} 오전 작업 보관본 줘`, [
    tool('list_invoice_runs', { date }),
    result => {
      assert.deepEqual(new Set(result.runs.map(run => run.runId)), new Set([first.run.id, second.run.id]));
      return '오전 작업이 두 개 있습니다. 어느 작업을 처리할까요?';
    },
  ]);
  assert.match(output.content, /어느 작업/);
  assert.doesNotMatch(output.content, /웹에서 작업 열기/);
  assert.ok(!s.webCalls.some(call => call.route.endsWith('/file')));
});
