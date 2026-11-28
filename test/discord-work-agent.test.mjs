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
    if (call.route === '/api/shipping/logen-export') call.format = requestUrl.searchParams.get('format');
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
    tool('collect_naver_orders', { lookbackDays: null, workDate: null }),
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

test('봇이 쿠팡 첨부 엑셀을 웹과 같은 주문 수집에 저장합니다', async t => {
  const session = await boot(t);
  const buffer = workbookBytes([
    ['주문번호', '묶음배송번호', '옵션ID', '등록상품명', '등록옵션명', '구매수(수량)', '수취인이름', '수취인 주소', '운송장번호', '출고일(발송일)'],
    ['000100', '000200', '000300', original[1][0], original[1][1], '2', '쿠팡 가상 수취인', '가상 배송지', '', ''],
  ]);
  const attachment = session.addAttachment({ name: '쿠팡 배송목록.xlsx', buffer });
  const result = await session.run('첨부한 쿠팡 주문 엑셀을 가져와서 수집 목록에 넣어줘.', [
    tool('import_coupang_orders', { workDate: null }),
    imported => {
      assert.equal(imported.collection.added, 1);
      assert.equal(imported.rows[0].provider, 'coupang');
      return tool('read_collected_orders', { query: '쿠팡', offset: 0 });
    },
    viewed => {
      assert.equal(viewed.rows[0].orderId, '000100');
      assert.equal(viewed.preparationQuantity, 2);
      return '쿠팡 상품주문 1건을 수집했습니다.';
    },
  ], [attachment]);
  assert.match(result.content, /쿠팡 주문 저장/);
  const stored = await (await session.web('/api/order-intake')).json();
  assert.deepEqual(stored.orders.map(order => [order.provider, order.orderId, order.quantity]), [['coupang', '000100', 2]]);
  assert.ok(!JSON.stringify(session.modelRequests).includes('가상 배송지'));
});

test('봇은 지정 작업일에 넣고 수취인으로 저장 주문을 찾은 뒤 웹과 같은 배송 수정 API를 쓴다', async t => {
  const workDate = '2026-11-27', productOrderId = '202611270100000093';
  const recipient = '관리용 수취인', formerAddress = '서울 가상구 이전로 21', address = '서울 가상구 수정로 25';
  const naver = { listNewOrders: async () => ({ orders: [{ productOrderId, orderId: '202611270100000099',
    productName: original[1][0], optionName: original[1][1], quantity: 1, paidAt: '2026-11-26T09:00:00+09:00',
    sourcePayload: { content: { productOrder: { shippingAddress: { name: recipient, tel1: '010-0000-7777', baseAddress: formerAddress } } } },
  }] }) };
  const session = await boot(t, { naver });
  const filters = { workDate, recipient, orderNumber: productOrderId, offset: 0 };
  const result = await session.run(`11월 27일 작업으로 네이버 주문을 불러와서 ${recipient} ${productOrderId}의 주소를 ${address}로 바꾸고 출고 보류해줘.`, [
    tool('collect_naver_orders', { lookbackDays: null, workDate }),
    () => tool('read_order_management', filters),
    found => {
      assert.equal(found.matchingRows, 1);
      assert.equal(found.rows[0].workDate, workDate);
      assert.ok(!JSON.stringify(found).includes(formerAddress));
      return tool('save_order_delivery', { rowId: found.rows[0].id, recipient: null, phone: null, baseAddress: address,
        detailedAddress: null, postalCode: null, memo: null, dispatchHeld: true });
    },
    saved => {
      assert.equal(saved.dispatchHeld, true);
      return '지정한 주문의 배송지를 수정하고 출고를 보류했습니다.';
    },
  ]);
  const stored = await (await session.web('/api/order-intake?' + new URLSearchParams({ view: 'management', workDate, recipient }))).json();
  assert.equal(stored.orders[0].shipping.baseAddress, address);
  assert.equal(stored.orders[0].dispatchHeld, true);
  assert.match(result.content, /주문 수정 저장/);
  assert.ok(!JSON.stringify(session.modelRequests).includes(formerAddress));
});

test('봇은 로젠 등록 파일의 요약만 읽고 로그인해서 받는 링크를 보냅니다', async t => {
  const productOrderId = '202611270400000001', address = '서울 가상구 비공개로 17';
  const session = await boot(t, { naver: { async listNewOrders() {
    return { from: '2026-11-20T00:00:00Z', to: '2026-11-27T00:00:00Z', orders: [{
      productOrderId, orderId: '202611270400000002', productName: original[1][0], originalName: original[1][0],
      optionName: original[1][1], quantity: 2, status: 'PAYED', placeOrderStatus: 'NOT_YET',
      sourcePayload: { content: { productOrder: { shippingAddress: {
        name: original[1][2], tel1: original[1][3], baseAddress: address, detailedAddress: '가상 101호', zipCode: '01234',
      } } } },
    }] };
  } } });
  await session.web('/api/order-intake/collect', json('POST', {}));
  const packing = await (await session.web('/api/order-intake/packing')).json();
  const dispatched = await (await session.web('/api/order-intake/dispatch', json('POST', {
    expectedVersion: packing.version, boxIds: [], orderItemIds: [packing.orders[0].id],
  }))).json();
  const { date } = dispatched;
  const result = await session.run(date + ' 출고 등록분을 로젠에 올릴 파일로 줘.', [
    tool('get_logen_export', { date }),
    result => {
      assert.deepEqual(result, { ok: true, date, boxCount: 1, display: `로젠 등록 파일 · ${date} · 1상자`,
        webTarget: { page: 'logen-export', date } });
      return '출고 등록한 1상자를 확인했습니다.';
    },
  ]);
  assert.deepEqual(session.calls.filter(call => call.route === '/api/shipping/logen-export'), [
    { route: '/api/shipping/logen-export', method: 'GET', format: 'summary', status: 200 },
  ]);
  assert.match(result.content, /출고 등록한 1상자를 확인했습니다/);
  assert.ok(result.content.includes(`[로젠 등록 파일 받기](https://system0.example/api/shipping/logen-export?date=${date})`));
  assert.equal(result.files, undefined);
  assert.doesNotMatch(JSON.stringify(session.modelRequests), /가상 101호|01234/);
});

test('봇은 네이버 취소를 확인한 뒤 출고 가능 상자와 웹의 같은 결과를 안내합니다', async t => {
  const ids = ['202611270500000001', '202611270500000002'];
  const orders = ids.map(productOrderId => ({
    productOrderId, orderId: productOrderId, originalName: original[1][0], productName: original[1][0],
    optionName: original[1][1], quantity: 1, status: 'PAYED', placeOrderStatus: 'NOT_YET',
    sourcePayload: { content: { productOrder: { shippingAddress: {
      name: original[1][2], tel1: original[1][3], baseAddress: original[1][4], detailedAddress: '가상 101호', zipCode: '01234',
    } } } },
  }));
  const lookups = [];
  const session = await boot(t, { naver: {
    async listNewOrders() { return { from: '2026-11-20T00:00:00Z', to: '2026-11-27T00:00:00Z', orders }; },
    async queryProductOrders(productOrderIds, options) {
      lookups.push({ ids: [...productOrderIds].sort(), options });
      return orders.map(({ productOrderId, orderId }, index) => ({ productOrderId, orderId,
        status: index ? 'CANCELED' : 'PAYED', remainQuantity: index ? 0 : 1, claimStatus: index ? 'CANCEL_DONE' : '' }));
    },
  } });
  await session.web('/api/order-intake/collect', json('POST', {}));
  const packing = await (await session.web('/api/order-intake/packing')).json();
  const { date } = await (await session.web('/api/order-intake/dispatch', json('POST', {
    expectedVersion: packing.version, boxIds: [], orderItemIds: packing.orders.map(order => order.id),
  }))).json();
  const boardRoute = '/api/shipping/board?date=' + date;
  const result = await session.run(`${date} 발송 전에 네이버에서 취소된 게 있는지 보고, 당장 준비할 새싹 수유쿠션 수량도 알려줘.`, [
    tool('check_shipping_cancellations', { date }),
    value => {
      assert.equal(value.ok, true);
      assert.deepEqual(value.webTarget, { page: 'shipping', date });
      assert.ok(value.summary.lastCheckedAt);
      const { lastCheckedAt, ...counts } = value.summary;
      assert.deepEqual(counts, { naverBoxCount: 2, matchedCount: 2, queriedCount: 2, readyCount: 1, holdCount: 0, canceledCount: 1, unverifiedCount: 0 });
      return tool('get_shipping_board', { date, batchId: null, registeredAt: null, search: '새싹 수유쿠션' });
    },
    async value => {
      const { registered } = await (await session.web(boardRoute)).json();
      assert.equal(value.registered.boxCount, registered.boxCount);
      assert.equal(value.registered.canceledBoxCount, registered.canceledBoxCount);
      assert.equal(value.registered.quantity, 1);
      assert.equal(value.registered.groups[0].quantity, 1);
      return '취소 1상자를 제외하고 새싹 수유쿠션 1개를 준비하면 됩니다.';
    },
  ]);
  assert.deepEqual(lookups, [{ ids, options: { includeIntake: true, allowMissing: true } }]);
  assert.ok(session.calls.some(call => call.route === '/api/shipping/cancellations/check' && call.method === 'POST' && call.status === 200));
  assert.match(result.content, /네이버 취소 확인.+출고 가능 1상자.+취소 1상자/);
  assert.ok(result.content.includes(`[웹에서 작업 열기](https://system0.example/shipping-board.html?date=${date})`));
  assert.doesNotMatch(JSON.stringify(session.modelRequests), new RegExp(ids.join('|')));
});

test('수집 주문 합포장과 낱개 분리는 봇과 웹에서 같은 상자와 잔여 수량을 사용합니다', async t => {
  const first = '202611270200000001', second = '202611270200000002';
  const order = (productOrderId, quantity) => ({
    productOrderId, orderId: productOrderId, quantity,
    originalName: original[1][0], productName: original[1][0], optionName: original[1][1],
    sourcePayload: { content: { productOrder: { shippingAddress: {
      name: '포장 테스트 수령인', zipCode: '12345', baseAddress: '서울 가상 배송 주소',
      detailedAddress: '가상 배송 상세', tel1: '010-9000-0001',
    } } } },
  });
  const session = await boot(t, { naver: { async listNewOrders() {
    return { from: '2026-11-20T00:00:00Z', to: '2026-11-27T00:00:00Z', orders: [order(first, 2), order(second, 1)] };
  } } });
  await session.web('/api/order-intake/collect', json('POST', {}));
  const route = '/api/order-intake/packing';
  const initial = await (await session.web(route)).json();
  const firstId = initial.orders.find(row => row.productOrderId === first).id;
  const secondId = initial.orders.find(row => row.productOrderId === second).id;
  const item = (orderItemId, quantity = 1) => ({ orderItemId, quantity });
  const combined = await session.run(`${first} 2개 중 1개와 ${second} 1개를 같은 상자에 넣고, 남은 1개는 다른 상자로 저장해줘.`, [
    tool('read_order_packing', { offset: 0, query: null }),
    result => {
      assert.equal(result.summary.unallocatedQuantity, 3);
      assert.ok(result.orders.every(order => order.destinationReady));
      return tool('save_order_packing', { removeBoxIds: [], boxes: [
        { items: [item(firstId), item(secondId)] }, { items: [item(firstId)] },
      ] });
    },
    result => {
      assert.equal(result.summary.boxCount, 2);
      assert.equal(result.summary.unallocatedQuantity, 0);
      return '두 상자의 포장 구성을 저장했습니다.';
    },
  ]);
  assert.match(combined.content, /포장 저장 · 새 상자 2개/);
  assert.match(combined.content, /\/#packing/);
  assert.ok(!JSON.stringify(session.modelRequests).includes('가상 배송 상세'));
  const saved = await (await session.web(route)).json();
  const joined = saved.boxes.find(box => box.items.length === 2);
  assert.ok(joined);
  const split = await (await session.web(route, json('PATCH', {
    expectedVersion: saved.version, removeBoxIds: [joined.id],
    boxes: [{ items: [item(firstId)] }, { items: [item(secondId)] }],
  }))).json();
  assert.equal(split.summary.boxCount, 3);
  assert.equal(split.summary.allocatedQuantity, 3);
  assert.equal(split.summary.unallocatedQuantity, 0);
  assert.deepEqual((await (await session.web('/api/order-intake')).json()).packing, split.summary);
  const firstBoxes = split.boxes.filter(box => box.items.some(item => item.orderItemId === firstId));
  const [deliveryBox, sibling] = firstBoxes;
  const splitAddress = '서울 가상 상자 배송 주소';
  let dispatchedDate;
  const dispatched = await session.run(`${first}의 상자 ${deliveryBox.id} 기본주소만 ${splitAddress}로 바꾸고 그 상자를 출고 등록해줘. 출고보드와 수집 잔여도 확인해줘.`, [
    tool('read_order_packing', { offset: 0, query: first }),
    result => {
      assert.equal(result.orders[0].productOrderId, first);
      assert.equal(result.boxes.find(box => box.id === deliveryBox.id).canEditDelivery, true);
      return tool('save_box_delivery', { boxId: deliveryBox.id, recipient: null, phone: null, baseAddress: splitAddress,
        detailedAddress: null, postalCode: null, memo: null });
    },
    async result => {
      assert.equal(result.hasDeliveryOverride, true);
      const after = await (await session.web(route)).json();
      assert.equal(after.boxes.find(box => box.id === deliveryBox.id).shipping.baseAddress, splitAddress);
      assert.deepEqual(after.boxes.find(box => box.id === sibling.id).shipping, sibling.shipping);
      return tool('register_order_dispatch', { boxIds: [deliveryBox.id], orderItemIds: [] });
    },
    result => {
      assert.equal(result.registeredCount, 1);
      assert.equal(result.registeredQuantity, 1);
      dispatchedDate = result.date;
      return tool('get_shipping_board', { date: dispatchedDate, batchId: null, registeredAt: null, search: null });
    },
    result => {
      assert.equal(result.registered.boxCount, 1);
      assert.equal(result.registered.quantity, 1);
      return tool('read_collected_orders', { offset: 0, query: first });
    },
    result => {
      assert.equal(result.rows[0].quantity, 1);
      return '상자 1개를 출고 등록했고 잔여 1개가 있습니다.';
    },
  ]);
  assert.match(dispatched.content, /상자 배송 정보 저장/);
  assert.match(dispatched.content, /출고 등록 · 상자 1개/);
  assert.ok(dispatched.content.includes('/shipping-board.html?date=' + dispatchedDate));
  const waiting = await (await session.web(route)).json();
  const final = await (await session.web('/api/order-intake/dispatch', json('POST', {
    expectedVersion: waiting.version, boxIds: waiting.boxes.map(box => box.id), orderItemIds: [],
  }))).json();
  assert.equal(final.registeredCount, 2);
  assert.deepEqual((await (await session.web('/api/order-intake')).json()).orders, []);
  assert.equal((await (await session.web('/api/shipping/board?date=' + final.date)).json()).registered.boxCount, 3);
  await session.run(`${first}의 출고 등록된 상자는 몇 개였어?`, [
    tool('read_order_management', { workDate: null, recipient: null, orderNumber: first, offset: 0 }),
    result => {
      assert.deepEqual(result.rows[0].registeredBoxes.map(box => [box.number, box.quantity]).sort(),
        [[deliveryBox.id, 1], [sibling.id, 1]].sort());
      assert.ok(!JSON.stringify(result).includes(splitAddress));
      return '등록된 분리배송 상자는 두 개입니다.';
    },
  ]);
  const page = await session.web('/order-packing.html');
  assert.match(await page.text(), /포장/);
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
    tool('get_shipping_board', { date, batchId: batch.id, registeredAt: null, search: '새싹' }),
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
      return tool('get_shipping_board', { date, batchId: batch.id, registeredAt: null, search: '새싹' });
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
