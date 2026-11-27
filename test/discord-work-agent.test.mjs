import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { createDiscordHandler } from '../lib/discord-bot.mjs';
import { courierFile, naverFile, sourceFile } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), 'absent-system0-' + randomUUID());
process.env.DISCORD_ENV_FILE = path.join(os.tmpdir(), 'absent-discord-' + randomUUID());
const { createApp } = await import('../server.mjs');

const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const config = { secret: 'work-agent-local-test-secret', guildId: scope.guildId, channelIds: [scope.channelId],
  userIds: [scope.userId], publicOrigin: 'https://system0.example' };
const original = [['상품명', '옵션명', '수취인명', '수취인연락처1', '주소', '수량'],
  ['가상 수유쿠션', '새싹·높이 13cm', '가상 수취인', '010-0000-0000', '서울 가상구 비공개로 17', 2]];
const originalName = '한글 주문.xlsx';
const cleanedName = '정리된 새싹 수유쿠션 High(13cm)';
const editedName = '검수한 새싹 수유쿠션 High(13cm)';
const attachmentUrl = 'https://cdn.discordapp.com/attachments/123/456/orders.xlsx?ex=fake';
const nameResult = { action: 'work_agent', date: null, message: null };
const tool = (name, args) => [name, args];
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const koreaDate = time => new Date(Date.parse(time) + 9 * 3600000).toISOString().slice(0, 10);

function workbookBytes(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '주문');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

function workbookRows(bytes) {
  const book = XLSX.read(Buffer.from(bytes), { type: 'buffer' });
  return XLSX.utils.sheet_to_json(book.Sheets['주문'], { header: 1 });
}

async function boot(t, options = {}) {
  const calls = [], modelRequests = [];
  const bytes = workbookBytes(original);
  const cdn = new Map([[attachmentUrl, bytes]]);
  const attachment = { name: originalName, size: bytes.length, url: attachmentUrl };
  const addAttachment = ({ name, buffer }) => {
    const url = 'https://cdn.discordapp.com/attachments/123/456/file-' + cdn.size + '.xlsx?ex=fake';
    cdn.set(url, buffer);
    return { name, size: buffer.length, url };
  };
  let steps;
  const client = { responses: { create: async request => {
    modelRequests.push(request);
    assert.equal(request.store, false);
    const sent = JSON.stringify(request);
    for (const value of [...original[1].slice(2, 5), ...cdn.keys(), config.secret]) assert.ok(!sent.includes(value), value);
    if (request.text?.format.name === 'discord_invoice_request') {
      assert.ok(request.text.format.schema.properties.action.enum.includes('work_agent'));
      return { output_text: JSON.stringify(nameResult) };
    }
    if (request.text?.format.name === 'product_names') {
      const rows = JSON.parse(request.input);
      assert.deepEqual(rows.map(row => [row.originalName, row.optionName]), [[original[1][0], original[1][1]]]);
      return { output_text: JSON.stringify({ items: rows.map(({ id }) => ({ id, cleanedName, needsAttention: false, note: '' })) }) };
    }
    const outputs = request.input.filter(entry => entry.type === 'function_call_output').map(entry => JSON.parse(entry.output));
    const step = steps[outputs.length];
    assert.ok(step, '예상한 도구 호출만 실행합니다.');
    const next = typeof step === 'function' ? await step(outputs.at(-1)) : step;
    if (typeof next === 'string') return { output_text: next };
    const [name, args] = next;
    assert.ok(request.tools.some(value => value.name === name), '모델이 공용 업무 도구를 받아야 합니다.');
    const call_id = 'call_work_' + modelRequests.length;
    return { output: [{ type: 'function_call', id: 'fc_' + modelRequests.length, call_id, name, arguments: JSON.stringify(args) }] };
  } } };
  const app = createApp({ databasePath: ':memory:', apiKey: '', client, model: 'local-mock', discordConfig: config, ...options });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    app.locals.db.close();
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const fetcher = (url, options) => {
    const requestUrl = new URL(url);
    const call = { route: requestUrl.pathname, method: options?.method || 'GET' };
    calls.push(call);
    if (cdn.has(url)) {
      assert.equal(options.redirect, 'error');
      return Promise.resolve(new Response(cdn.get(url)));
    }
    assert.equal(requestUrl.origin, baseUrl, '실제 외부 URL에는 요청하지 않습니다.');
    return fetch(url, options).then(response => { call.status = response.status; return response; });
  };
  const handle = createDiscordHandler({ config: { ...config, baseUrl }, fetcher });
  let eventId = 777777777777777770n;
  const run = (message, actions, attachments = []) => {
    steps = actions;
    return handle({ ...scope, id: String(eventId++), kind: 'message', text: message, attachments });
  };
  const web = async (route, options, status = 200) => {
    const response = await fetch(baseUrl + route, options);
    assert.equal(response.status, status, await response.clone().text());
    return response;
  };
  const importFromWeb = async ({ buffer = bytes, name = originalName } = {}) => {
    const form = new FormData();
    form.append('files', new Blob([buffer]), name);
    return (await web('/api/import', { method: 'POST', body: form }, 201)).json();
  };
  return { run, web, importFromWeb, calls, modelRequests, attachment, addAttachment };
}

test('봇이 네이버 수집·검수·준비 수량 조회를 조합하고 웹이 같은 상태를 읽습니다', async t => {
  const productOrderId = '202611270100000001', barcode = '1234567890128';
  let reads = 0, rowId;
  const session = await boot(t, { naver: { async listNewOrders() {
    reads++;
    return { from: '2026-11-20T00:00:00Z', to: '2026-11-27T00:00:00Z', orders: [{
      productOrderId, orderId: '202611270099999999', paidAt: '2026-11-27T09:00:00+09:00',
      productName: original[1][0], originalName: original[1][0], optionName: original[1][1], quantity: 2,
    }] };
  } } });
  await session.web('/api/products', json('POST', { barcode, name: editedName }), 201);
  await session.web('/api/products/' + barcode + '/costs', json('POST', { effectiveDate: '2026-11-26', unitCostKrw: 6500 }), 201);
  const result = await session.run(`발주 전 주문을 가져와서 ${productOrderId}번은 ${editedName}으로 검수하고 ${barcode}에 연결해줘. 같은 바코드 준비 수량도 봐줘.`, [
    tool('collect_naver_orders', { lookbackDays: null }),
    result => {
      assert.equal(result.collection.added, 1);
      assert.equal(result.rows[0].cleanedName, cleanedName);
      rowId = result.rows[0].id;
      return tool('save_collected_order_review', { rowId, cleanedName: editedName, skuBarcode: barcode });
    },
    result => {
      assert.equal(result.rows[0].skuBarcode, barcode);
      return tool('read_collected_orders', { offset: 0, query: barcode });
    },
    async result => {
      const fromWeb = await (await session.web('/api/order-intake')).json();
      assert.equal(fromWeb.orders[0].id, rowId);
      assert.equal(fromWeb.orders[0].cleanedName, editedName);
      assert.equal(fromWeb.orders[0].cost.totalCost, 13000);
      assert.deepEqual(result.summary, fromWeb.summary);
      assert.equal(result.preparationQuantity, fromWeb.groups[0].count);
      return '지정 상품을 검수했고 2개를 준비하면 됩니다.';
    },
  ]);
  assert.equal(reads, 1);
  assert.match(result.content, /새 상품주문 1건/);
  assert.match(result.content, /수집 주문 검수 저장/);
  assert.ok(session.calls.some(call => call.route === '/api/order-intake/orders/' + rowId && call.method === 'PATCH'));
});

test('디스코드 주문 첨부, 정리, 검수, 엑셀이 웹과 같은 작업과 원본 값을 사용합니다', async t => {
  const session = await boot(t);
  let batchId;
  const output = await session.run('첨부한 주문 엑셀을 불러와 미정리 상품명을 정리해줘. 원본 2행은 ' + editedName
    + '으로 수정해 검수 완료로 저장한 뒤 전체 주문 엑셀을 줘.', [
    tool('import_order_files', {}),
    result => {
      assert.equal(result.ok, true);
      assert.equal(result.summary.pending, 1);
      batchId = result.batchId;
      return tool('normalize_order_names', { batchId, rowIds: null });
    },
    result => {
      assert.equal(result.ok, true);
      assert.equal(result.rows[0].cleanedName, cleanedName);
      return tool('save_order_review', { batchId, changes: [
        { rowId: result.rows[0].id, cleanedName: editedName, reviewNote: null, status: 'confirmed' },
      ] });
    },
    result => {
      assert.equal(result.ok, true);
      assert.equal(result.rows[0].status, 'confirmed');
      return tool('export_order_file', { batchId, kind: 'orders' });
    },
    result => { assert.equal(result.ok, true); return '정리된 주문 엑셀입니다.'; },
  ], [session.attachment]);
  assert.equal(output.files?.[0]?.name, '한글 주문_상품명정리.xlsx', output.content);
  const modelInput = session.modelRequests.filter(request => request.tools).map(request => request.instructions + JSON.stringify(request.input));
  assert.ok(modelInput[0].includes(originalName));
  const shared = await (await session.web('/api/batches/' + batchId)).json();
  assert.equal(shared.rows[0].generatedName, cleanedName);
  assert.equal(shared.rows[0].cleanedName, editedName);
  assert.equal(shared.rows[0].status, 'confirmed');
  const fromWeb = await session.web('/api/batches/' + batchId + '/export?kind=orders');
  assert.deepEqual(workbookRows(output.files[0].attachment), workbookRows(await fromWeb.arrayBuffer()));
  assert.deepEqual(workbookRows(output.files[0].attachment), [original[0], [editedName, ...original[1].slice(1)]]);
  assert.ok(session.calls.some(call => call.route === '/api/import' && call.method === 'POST' && call.status === 201));
  assert.ok(session.calls.some(call => call.route === '/api/batches/' + batchId + '/normalize' && call.method === 'POST' && call.status === 200));
  assert.ok(session.calls.some(call => call.route === '/api/batches/' + batchId + '/rows' && call.method === 'PATCH' && call.status === 200));
});

test('출고 조회 결과와 웹에서 할 상품·바코드 관리 작업을 한 답변에 표시합니다', async t => {
  const session = await boot(t);
  const { batch, rows } = await session.importFromWeb();
  const date = koreaDate(batch.createdAt), route = '/api/shipping/board?date=' + date + '&batchId=' + batch.id;
  await session.web('/api/batches/' + batch.id + '/rows', json('PATCH', { changes: [
    { id: rows[0].id, cleanedName: editedName, status: 'confirmed', reviewNote: '' },
  ] }));
  const webBoard = await (await session.web(route)).json();
  const output = await session.run(date + ' 출고보드에서 새싹 수유쿠션 수량을 알려주고 상품·바코드 관리에서 신규 상품 등록도 해줘.', [
    tool('get_shipping_board', { date, batchId: batch.id, search: '새싹' }),
    result => {
      assert.equal(result.ok, true);
      assert.deepEqual(result.summary, webBoard.summary);
      assert.deepEqual(result.groups.map(({ name, count }) => ({ name, count })),
        webBoard.groups.map(({ name, count }) => ({ name, count })));
      return tool('handoff_work_to_web', { task: 'product_create' });
    },
    () => '새싹 수유쿠션 출고 1묶음입니다.',
  ]);
  assert.match(output.content, /\*\*완료\*\*/);
  assert.match(output.content, /[1１]\s*묶음/);
  assert.match(output.content, /\*\*미완료\*\*[\s\S]*(상품·바코드|상품 등록)/);
  assert.match(output.content, /https:\/\/system0\.example\/products\.html/);
  assert.ok(session.calls.some(call => call.route === '/api/shipping/board' && call.method === 'GET' && call.status === 200));
  assert.ok(!session.calls.some(call => call.route === '/api/products' && call.method !== 'GET'));
});

test('같은 디스코드 요청에서 첨부 송장을 매칭하고 출고 보드를 조회합니다', async t => {
  const session = await boot(t);
  const [productName, optionName, recipient, phone, address] = original[1];
  const order = { productName, optionName, recipient, phone, address, quantity: 1,
    productOrderId: '2026112000000001', orderId: '2026112000000009', internalId: '000001', trackingNumber: '45500000001' };
  const { batch, rows: [row] } = await session.importFromWeb(sourceFile([order]));
  const date = koreaDate(batch.createdAt);
  await session.web('/api/batches/' + batch.id + '/rows', json('PATCH', { changes: [
    { id: row.id, cleanedName: editedName, status: 'confirmed', reviewNote: '' },
  ] }));
  const attachments = [naverFile([order]), courierFile([{ ...order, printedAt: date + 'T17:00:00+09:00' }])].map(session.addAttachment);
  let runId;
  const output = await session.run(date + ' 첨부한 네이버와 로젠 파일을 매칭하고 새싹 수유쿠션 출고 수량도 알려줘.', [
    tool('import_invoice_files', { date }),
    result => {
      assert.equal(result.ok, true);
      assert.equal(result.items[0].trackingNumber, order.trackingNumber);
      runId = result.runId;
      return tool('get_shipping_board', { date, batchId: batch.id, search: '새싹' });
    },
    result => {
      assert.equal(result.ok, true);
      assert.equal(result.groups[0].name, editedName);
      assert.equal(result.matchingQuantity, 1);
      return '새싹 수유쿠션 출고 1묶음입니다.';
    },
  ], attachments);
  assert.match(output.content, /송장 파일 매칭[\s\S]*1묶음/);
  const webRun = await (await session.web('/api/invoices/' + runId)).json();
  assert.equal(webRun.items[0].trackingNumber, order.trackingNumber);
  assert.deepEqual(session.calls.filter(call => ['/api/invoices/import', '/api/shipping/board'].includes(call.route)), [
    { route: '/api/invoices/import', method: 'POST', status: 201 },
    { route: '/api/shipping/board', method: 'GET', status: 200 },
  ]);
});

test('웹에서 먼저 저장한 상품명 검수를 덮어쓰지 않고 같은 작업을 안내합니다', async t => {
  const session = await boot(t);
  const { batch, rows: [row] } = await session.importFromWeb();
  const batchId = batch.id, batchPath = '/api/batches/' + batchId;
  const output = await session.run(`주문 작업 #${batchId}의 원본 2행을 ${cleanedName}으로 수정해 검수 완료로 저장해줘.`, [
    tool('read_order_batch', { batchId, offset: 0, query: null }),
    async result => {
      assert.equal(result.rows[0].id, row.id);
      await session.web(batchPath + '/rows', json('PATCH', { changes: [
        { id: row.id, cleanedName: editedName, status: 'confirmed', reviewNote: '웹 검수' },
      ] }));
      return tool('save_order_review', { batchId, changes: [{ rowId: row.id, cleanedName, reviewNote: null, status: 'confirmed' }] });
    },
    () => '상품명 변경을 완료했습니다.',
  ]);
  assert.match(output.content, /\*\*미완료\*\*[\s\S]*검수 내용이 바뀌었습니다/);
  assert.ok(output.content.includes(`[웹에서 작업 열기](https://system0.example/?batch=${batchId})`), output.content);
  const latest = await (await session.web(batchPath)).json();
  assert.equal(latest.rows[0].cleanedName, editedName);
  assert.equal(latest.rows[0].reviewNote, '웹 검수');
});

test('주문 첨부 링크를 모델에 보내거나 디스코드 외부 파일을 가져오지 않습니다', async t => {
  const session = await boot(t);
  const invalid = { ...session.attachment, url: 'https://outside.example/orders.xlsx' };
  const output = await session.run('이 주문 엑셀을 불러와 줘.', [tool('import_order_files', {}), '파일 불러오기 결과입니다.'], [invalid]);
  assert.match(output.content, /디스코드에 직접 첨부한 파일만/);
  assert.ok(!session.calls.some(call => call.route === '/orders.xlsx' || call.route === '/api/import'));
  assert.deepEqual((await (await session.web('/api/batches')).json()).batches, []);
});
