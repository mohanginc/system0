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

async function boot(t, originalOrders, remoteOrders = originalOrders) {
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
      return ids.map(id => registeredOrder(byProduct.get(id)));
    },
  };
  const app = createApp({ databasePath: ':memory:', apiKey: '', client, model: 'local-mock', discordConfig: config, naver });
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
  const handle = createDiscordHandler({ config: { ...config, baseUrl }, fetcher });
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
  return { event, run, start, get, file, select, save, check, setGeneratedAt, setCreatedAt, webCalls, naverCalls, toolRequests };
}

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
  const outside = order(2, { orderId: '20261116-0000002', productName: '[coupang] 가상 제품 2' });
  const s = await boot(t, [naverOrder, outside], [naverOrder]);
  const before = await s.start([naverOrder], [naverOrder, outside]), runId = before.run.id;
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
        + `로젠 송장 엑셀 ${file} ${row}행의 송장번호 ${trackingNumber}는 같은 출고 건입니다. ${note.registration}`;
    },
  ]);
  assert.match(output.content, /저장 주문 엑셀.*3행의 체결번호.*로젠 송장 엑셀.*3행의 송장번호.*같은 출고 건/);
  assert.match(output.content, /등록 여부는 조회하지 않았습니다/);
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
  const ready = order(1), hold = order(2), exclude = order(3);
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
    result => { assert.equal(result.ok, true); return '남은 주문의 업로드용 엑셀입니다.'; },
  ]);
  assert.equal(output.files?.length, 1, output.content);
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
