import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { createDiscordHandler } from '../lib/discord-bot.mjs';
import { discordMessageAddressed } from '../lib/discord-config.mjs';
import { courierFile, naverFile, sourceFile } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), 'absent-system0-' + randomUUID());
process.env.DISCORD_ENV_FILE = path.join(os.tmpdir(), 'absent-discord-' + randomUUID());
const { createApp } = await import('../server.mjs');

const date = '2026-11-16';
const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const otherUser = '444444444444444444';
const mentionChannel = '555555555555555555';
const config = { secret: 'conversation-local-test-secret', guildId: scope.guildId, channelIds: [scope.channelId, mentionChannel],
  plainMessageChannelIds: [scope.channelId], userIds: [scope.userId, otherUser], publicOrigin: 'https://system0.example' };
const plain = { mentioned: false };
const order = n => ({ productOrderId: '2026111600000000' + n, orderId: '2026111600000009' + n,
  internalId: '00000' + n, trackingNumber: '0455000000' + n, productName: '가상 제품 ' + n, optionName: String(n),
  recipient: '가상 수취인', phone: '010-0000-0000', address: '서울 가상 주소 101호', quantity: 1 });
const secondNumber = '04550000009';
const followup = '재출력이야. 두 번째 송장으로 적용해줘';
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function boot(t, { naver, extraOrders = [] } = {}) {
  const toolRequests = [], workerCalls = [];
  let nextTurn;
  const client = { responses: { create: async request => {
    assert.equal(request.store, false);
    const transcript = JSON.stringify({ input: request.input, instructions: request.instructions });
    for (const value of [config.secret, '가상 수취인', '010-0000-0000', '서울 가상 주소 101호']) assert.ok(!transcript.includes(value), value);
    if (request.text?.format?.name === 'product_names') {
      const items = JSON.parse(request.input).map(row => ({ id: row.id, cleanedName: row.originalName, needsAttention: false, note: '' }));
      return { output_text: JSON.stringify({ items }) };
    }
    toolRequests.push(transcript);
    const outputs = request.input.filter(entry => entry.type === 'function_call_output').map(entry => JSON.parse(entry.output));
    const [action, args] = nextTurn(outputs, transcript) || [];
    assert.ok(action, '예상한 순서로만 도구를 호출합니다.');
    if (!args) return { output_text: action };
    assert.ok(request.tools.some(value => value.name === action));
    const call_id = 'call_conversation_' + toolRequests.length;
    return { output: [{ type: 'function_call', id: 'fc_' + toolRequests.length, call_id, name: action, arguments: JSON.stringify(args) }] };
  } } };
  const app = createApp({ databasePath: ':memory:', apiKey: '', client, model: 'mock-local', discordConfig: config, naver });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    app.locals.db.close();
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const fetcher = (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, baseUrl);
    const call = { path: target.pathname, method: options.method || 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined };
    workerCalls.push(call);
    return fetch(url, options).then(response => { call.status = response.status; return response; });
  };
  const handle = createDiscordHandler({ config: { ...config, baseUrl }, fetcher });
  const request = async (route, options, status = 200) => {
    const response = await fetch(baseUrl + route, options);
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  const formFile = (form, key, file) => form.append(key, new Blob([file.buffer]), file.name);
  const first = order(1), other = order(2);
  const source = new FormData();
  formFile(source, 'files', sourceFile([first, other, ...extraOrders]));
  const imported = await request('/api/import', { method: 'POST', body: source }, 201);
  app.locals.db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(`${date}T01:00:00.000Z`, imported.batch.id);
  const start = async product => {
    const form = new FormData();
    const second = { ...product, trackingNumber: product === first ? secondNumber : '04550000008', round: 2 };
    formFile(form, 'naverFiles', naverFile([product]));
    formFile(form, 'courierFiles', courierFile([{ ...product, round: 1 }, second]));
    form.append('deliveryCompanyCode', 'KGB');
    form.append('sourceDate', date);
    const view = await request('/api/invoices/import', { method: 'POST', body: form }, 201);
    assert.equal(view.trackingReview.groups.length, 1);
    assert.equal(view.trackingReview.groups[0].replaceEligible, true);
    return { view, product, second };
  };
  const startReprints = async products => {
    const form = new FormData();
    const reprints = products.map((product, i) => ({ ...product, trackingNumber: `0466000000${i}`, round: 1,
      originalTrackingNumber: product.trackingNumber, issueCount: 2, printedAt: '15:15:10' }));
    formFile(form, 'naverFiles', naverFile(products));
    formFile(form, 'courierFiles', courierFile(reprints));
    form.append('deliveryCompanyCode', 'KGB');
    form.append('sourceDate', date);
    return { view: await request('/api/invoices/import', { method: 'POST', body: form }, 201), reprints };
  };
  let eventId = 666666666666666660n;
  async function invoke(text, steps, { replyToId = null, userId = scope.userId, mentioned = true, channelId = scope.channelId } = {}) {
    if (!discordMessageAddressed(config, { ...scope, channelId, userId, mentioned, replyToBot: Boolean(replyToId) })) return null;
    const botMessageId = String(eventId++);
    nextTurn = (outputs, transcript) => {
      const step = steps[outputs.length];
      assert.ok(step, '이 요청에서는 추가 모델 호출이 없어야 합니다.');
      const value = typeof step === 'function' ? step(outputs.at(-1), transcript) : step;
      return Array.isArray(value) ? value : [value];
    };
    const messageId = String(eventId++);
    const output = await handle({ ...scope, channelId, userId, id: messageId, kind: 'message', text, botMessageId, replyToId });
    return { output, botMessageId, messageId };
  }
  const get = runId => request('/api/invoices/' + runId);
  const webNote = view => request(`/api/invoices/${view.run.id}/items`, json('PATCH', { expectedVersion: view.viewVersion,
    changes: [{ id: view.items[0].id, decision: view.items[0].decision, note: '웹에서 먼저 수정' }] }));
  const setSavedTime = (messageId, time) => {
    assert.equal(app.locals.db.prepare('UPDATE discord_conversation_turns SET created_at = ? WHERE message_id = ?').run(time, messageId).changes, 1);
  };
  return { first, other, start, startReprints, invoke, get, webNote, setSavedTime, toolRequests, workerCalls };
}

function suppliedConversation(transcript) {
  const { content } = JSON.parse(transcript).input[0];
  return content.startsWith('{') ? JSON.parse(content).conversation : undefined;
}

function assertToday(transcript, expected) {
  const conversation = suppliedConversation(transcript);
  assert.deepEqual(conversation.todayTurns.map(({ userText, botText }) => [userText, botText]), expected);
  assert.equal(conversation.turns, undefined);
}

function savedConversation(s, messageId) {
  const save = s.workerCalls.find(call => call.path === '/api/discord/conversation/save' && call.body?.messageId === messageId);
  assert.equal(save?.status, 200);
  return save.body.conversationId;
}

function askForTracking(s, target, text, options) {
  return s.invoke(text, [
    ['review_invoice_tracking', { runId: target.view.run.id, bulkReplacement: false }],
    result => {
      assert.equal(result.ok, true);
      assert.equal(result.trackingGroups.length, 1);
      return `송장 작업 #${target.view.run.id}의 두 후보입니다. 첫 번째 ${target.product.trackingNumber}, 두 번째 ${target.second.trackingNumber}. 재출력인지 분리 배송인지 알려주세요.`;
    },
  ], options);
}

function applySecond(s, target, replyToId, onRead, options) {
  const runId = target.view.run.id;
  return s.invoke(followup, [
    (result, transcript) => {
      onRead?.(transcript);
      return ['read_invoice', { runId }];
    },
    ['select_invoice_tracking', { runId, productOrderId: target.product.productOrderId,
      trackingNumber: target.second.trackingNumber, mode: 'replace' }],
    result => result.ok ? '두 번째 송장으로 적용했습니다.' : '앞의 선택은 적용하지 못했습니다.',
  ], { replyToId, ...options });
}

test('봇 답장으로 한 업무의 송장 후보를 이어받아 웹에 두 번째 송장을 저장합니다', async t => {
  const s = await boot(t), target = await s.start(s.first), unrelated = await s.start(s.other);
  const firstText = `오전 재출력 문의입니다. 송장 작업 #${target.view.run.id}에서 송장 후보를 확인해줘`;
  const first = await askForTracking(s, target, firstText, { channelId: mentionChannel });
  assert.match(first.output.content, /재출력인지 분리 배송인지/);
  const unrelatedText = `다른 포장 확인입니다. 송장 작업 #${unrelated.view.run.id}의 상태만 알려줘`;
  await s.invoke(unrelatedText, [
    (result, transcript) => {
      assert.ok(!suppliedConversation(transcript)?.turns?.some(turn => turn.userText === firstText));
      return ['read_invoice', { runId: unrelated.view.run.id }];
    },
    '다른 포장 주문의 상태를 확인했습니다.',
  ], { channelId: mentionChannel });

  const current = await applySecond(s, target, first.botMessageId, transcript => {
    assert.ok(transcript.includes(firstText));
    assert.ok(transcript.includes(`두 번째 ${target.second.trackingNumber}`));
    assert.ok(!transcript.includes(unrelatedText));
    assert.ok(!transcript.includes('다른 포장 주문의 상태를 확인했습니다.'));
  }, { channelId: mentionChannel });
  assert.match(current.output.content, /두 번째 송장으로 적용했습니다/);
  const after = await s.get(target.view.run.id);
  assert.equal(after.items[0].trackingNumber, target.second.trackingNumber);
  assert.equal(after.items[0].trackingSelection.mode, 'replace');
  assert.equal((await s.get(unrelated.view.run.id)).viewVersion, unrelated.view.viewVersion);
  const mutations = s.workerCalls.filter(call => call.path === `/api/invoices/${target.view.run.id}/tracking`);
  assert.deepEqual(mutations.map(call => [call.body.validateOnly === true, call.status]), [[true, 200], [false, 200]]);
});

test('멘션 없는 일반 메시지는 지정 업무 채널의 허용 직원에게만 열고 기존 멘션과 답장을 유지합니다', () => {
  const addressed = overrides => discordMessageAddressed(config, { ...scope, mentioned: false, replyToBot: false, ...overrides });
  assert.equal(addressed({}), true);
  assert.equal(addressed({ userId: otherUser }), true);
  assert.equal(addressed({ userId: '777777777777777777', mentioned: true }), false);
  assert.equal(addressed({ guildId: '777777777777777777' }), false);
  assert.equal(addressed({ channelId: '777777777777777777', mentioned: true }), false);
  assert.equal(addressed({ channelId: mentionChannel }), false);
  assert.equal(addressed({ channelId: mentionChannel, mentioned: true }), true);
  assert.equal(addressed({ channelId: mentionChannel, replyToBot: true }), true);
});

test('업무 채널의 다른 직원이 답장으로 송장 업무를 넘겨받고 새 출고 조회도 처리합니다', async t => {
  const s = await boot(t), first = await s.start(s.first), second = await s.start(s.other);
  const firstId = first.view.run.id, secondId = second.view.run.id;
  const firstText = `송장 작업 #${firstId}에 중복 송장 후보를 알려줘`;
  const secondText = `송장 작업 #${secondId}에 교체할 송장 후보를 알려줘`;
  const shippingText = '오늘 양손프리 출고 수량 알려줘';
  const otherChannelText = '다른 채널에서 따로 문의한 출고 수량';
  const secondViewBefore = await s.get(secondId);
  await s.invoke(otherChannelText, ['다른 채널에서 확인했습니다.'], { channelId: mentionChannel });
  const firstOutput = await askForTracking(s, first, firstText, plain);
  assert.match(firstOutput.output.content, /재출력인지 분리 배송인지/);

  const secondOutput = await s.invoke(secondText, [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstOutput.output.content]]);
      assert.ok(!transcript.includes(otherChannelText));
      return ['review_invoice_tracking', { runId: secondId, bulkReplacement: false }];
    },
    result => {
      assert.equal(result.choiceToConfirm.runId, secondId);
      return `두 번째 후보는 ${second.second.trackingNumber}입니다.`;
    },
  ], { ...plain, userId: otherUser });
  assert.match(secondOutput.output.content, /두 번째 후보/);

  const shipping = await s.invoke(shippingText, [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstOutput.output.content], [secondText, secondOutput.output.content]]);
      assert.ok(!transcript.includes(otherChannelText));
      return ['get_shipping_board', { date, batchId: null, registeredAt: null, search: '양손프리' }];
    },
    result => { assert.equal(result.ok, true); return `양손프리 ${result.matchingQuantity}묶음입니다.`; },
  ], plain);
  assert.match(shipping.output.content, /양손프리.*묶음/);
  assert.equal(savedConversation(s, shipping.messageId), null);

  const replacement = await s.invoke('재출력이야. 두 번째 걸로 적용해줘', [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstOutput.output.content], [secondText, secondOutput.output.content],
        [shippingText, shipping.output.content]]);
      assert.equal(suppliedConversation(transcript).pending.runId, firstId);
      assert.ok(!transcript.includes(otherChannelText));
      return ['read_invoice', { runId: firstId }];
    },
    ['select_invoice_tracking', { runId: firstId, productOrderId: first.product.productOrderId,
      trackingNumber: first.second.trackingNumber, mode: 'replace' }],
    result => { assert.equal(result.ok, true); return '두 번째 송장으로 적용했습니다.'; },
  ], { ...plain, userId: otherUser, replyToId: firstOutput.botMessageId });
  assert.match(replacement.output.content, /두 번째 송장으로 적용했습니다/);
  const current = await s.get(firstId);
  assert.equal(current.items[0].trackingNumber, first.second.trackingNumber);
  assert.equal(current.items[0].trackingSelection.mode, 'replace');
  assert.equal(current.items[0].trackingSelection.actor, `discord:${otherUser}`);
  assert.equal((await s.get(secondId)).viewVersion, secondViewBefore.viewVersion);
  const trackingCalls = s.workerCalls.filter(call => /\/tracking$/.test(call.path));
  assert.deepEqual(trackingCalls.map(call => [call.path, call.body.validateOnly === true, call.status]),
    [[`/api/invoices/${firstId}/tracking`, true, 200], [`/api/invoices/${firstId}/tracking`, false, 200]]);
});

test('일반 채팅의 후속 질문은 선택 대기 없이 조회하던 송장 작업을 찾습니다', async t => {
  const s = await boot(t), target = await s.start(s.first), runId = target.view.run.id;
  const firstText = `송장 작업 #${runId} 결과 확인해줘`;
  const firstAnswer = '이 주문은 적용할 송장을 아직 선택하지 않았습니다.';
  await s.invoke(firstText, [['read_invoice', { runId }], firstAnswer], plain);

  const { output } = await s.invoke('그럼 왜 누락됐어?', [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstAnswer]]);
      return ['read_invoice', { runId }];
    },
    result => {
      assert.equal(result.trackingGroups[0].candidates.length, 2);
      return '송장 후보가 두 개라 선택이 필요합니다.';
    },
  ], plain);
  assert.match(output.content, /송장 후보가 두 개라 선택이 필요합니다/);
  assert.ok(!s.workerCalls.some(call => /\/tracking$/.test(call.path)));
});

function naverNewOrders() {
  const orders = [['양손프리 가상 상품', 2], ['다른 가상 상품', 3]].map(([name, quantity], index) => ({
    ...order(index + 1), originalName: name, productName: name, optionName: '', quantity,
  }));
  return { listNewOrders: async () => ({ from: `${date}T00:00:00Z`, to: `${date}T03:00:00Z`, orders }) };
}

function quantityFromNewOrders(result) {
  assert.equal(result.ok, true);
  assert.equal(result.unit, '개');
  assert.equal(result.summary.quantity, 5);
  assert.equal(result.matchingQuantity, 2);
  return `네이버 신규 주문 중 양손프리 잔여 수량은 ${result.matchingQuantity}개입니다.`;
}

test('일반 채팅에서 조회 대상을 신규 주문으로 정정하고 그중 양손프리 수량을 이어서 조회합니다', async t => {
  const s = await boot(t, { naver: naverNewOrders() });
  const firstText = '오늘 양손프리 출고 수량 알려줘';
  const firstReply = '오늘 출고 보드 기준 양손프리 출고 수량은 0묶음입니다.';
  await s.invoke(firstText, [['get_shipping_board', { date, batchId: null, registeredAt: null, search: '양손프리' }], firstReply], plain);

  const correction = '시스템에 등록된것 말고 현재 주문들어와있는것 중에 준비해야할것들말야';
  const corrected = await s.invoke(correction, [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstReply]]);
      return ['preview_new_orders', { search: '양손프리' }];
    },
    quantityFromNewOrders,
  ], plain);
  assert.match(corrected.output.content, /신규 주문 중 양손프리 잔여 수량은 2개/);

  const followupText = '그중에 양손프리가 몇개야?';
  const continued = await s.invoke(followupText, [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstReply], [correction, corrected.output.content]]);
      return ['preview_new_orders', { search: '양손프리' }];
    },
    quantityFromNewOrders,
  ], plain);
  assert.match(continued.output.content, /신규 주문 중 양손프리 잔여 수량은 2개/);

  const scopeAnswer = '신규주문에서';
  const scoped = await s.invoke(scopeAnswer, [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstReply], [correction, corrected.output.content], [followupText, continued.output.content]]);
      return ['preview_new_orders', { search: '양손프리' }];
    },
    quantityFromNewOrders,
  ], plain);
  assert.match(scoped.output.content, /신규 주문 중 양손프리 잔여 수량은 2개/);

  const newText = '오늘 출고 보드의 다른 상품 수량을 알려줘';
  const newReply = '오늘 출고 보드의 다른 상품 수량은 0묶음입니다.';
  const unrelated = await s.invoke(newText, [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstReply], [correction, corrected.output.content],
        [followupText, continued.output.content], [scopeAnswer, scoped.output.content]]);
      return ['get_shipping_board', { date, batchId: null, registeredAt: null, search: '다른 상품' }];
    },
    newReply,
  ], plain);
  assert.equal(savedConversation(s, unrelated.messageId), null);

  const olderFollowup = await s.invoke('좀 전 접수 건들 준비 목록으로 돌아가서 양손프리만 다시 세어줄래?', [
    (_result, transcript) => {
      assertToday(transcript, [[firstText, firstReply], [correction, corrected.output.content],
        [followupText, continued.output.content], [scopeAnswer, scoped.output.content], [newText, newReply]]);
      return ['preview_new_orders', { search: '양손프리' }];
    },
    quantityFromNewOrders,
  ], plain);
  assert.match(olderFollowup.output.content, /신규 주문 중 양손프리 잔여 수량은 2개/);
  assert.equal(s.workerCalls.filter(call => call.path === '/api/shipping/board').length, 2);
  assert.equal(s.workerCalls.filter(call => call.path === '/api/shipping/preview').length, 4);
  assert.ok(!s.workerCalls.some(call => call.body?.olderHistoryOnly));
});

test('신규주문에서라는 짧은 응답은 직전 질문의 양손프리 조건을 이어받습니다', async t => {
  const s = await boot(t, { naver: naverNewOrders() });
  const question = '양손프리가 몇개야?';
  const botQuestion = '신규 주문인지, 출고 보드인지 알려주세요.';
  await s.invoke(question, [botQuestion], plain);
  const { output } = await s.invoke('신규주문에서', [
    (_result, transcript) => {
      assertToday(transcript, [[question, botQuestion]]);
      return ['preview_new_orders', { search: '양손프리' }];
    },
    quantityFromNewOrders,
  ], plain);
  assert.match(output.content, /신규 주문 중 양손프리 잔여 수량은 2개/);
  assert.equal(s.workerCalls.filter(call => call.path === '/api/shipping/preview').length, 1);
});

test('당일 업무 대화는 다섯 턴을 넘겨도 먼저 보내고 지난 대화는 요청할 때만 조회합니다', async t => {
  const s = await boot(t);
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const cutoff = Date.parse(`${today}T00:00:00+09:00`);
  const olderText = '양손프리 지난달 비교는 결제일로 조회해줘';
  const olderReply = '양손프리 비교 조회 기준은 결제일입니다.';
  const older = await s.invoke(olderText, [olderReply], plain);
  s.setSavedTime(older.messageId, cutoff - 2);
  const olderOtherText = '양손프리 다른 직원의 조회';
  const olderOtherReply = '배송일입니다.';
  const olderOther = await s.invoke(olderOtherText, [olderOtherReply], { ...plain, userId: otherUser });
  s.setSavedTime(olderOther.messageId, cutoff - 1);
  const otherChannel = await s.invoke('양손프리 다른 채널의 조회', ['다른 채널 답변입니다.'], { channelId: mentionChannel });
  s.setSavedTime(otherChannel.messageId, cutoff - 1);

  const todayTurns = Array.from({ length: 6 }, (_, index) => [`당일 참고 항목 ${index + 1}을 알려줘`, `참고 항목 ${index + 1}입니다.`]);
  for (const [question, answer] of todayTurns) await s.invoke(question, [answer], plain);

  const { output } = await s.invoke('어제 말한 양손프리 비교 조회 기준이 뭐였지?', [
    (_result, transcript) => {
      assertToday(transcript, todayTurns);
      assert.ok(!transcript.includes(olderReply));
      assert.ok(!transcript.includes(olderOtherReply));
      assert.ok(!transcript.includes('다른 채널 답변입니다.'));
      assert.ok(!s.workerCalls.some(call => call.body?.olderHistoryOnly));
      return ['search_older_conversations', { query: '양손프리' }];
    },
    result => {
      assert.equal(result.ok, true);
      assert.deepEqual(result.turns.map(({ userText, botText }) => [userText, botText]),
        [[olderText, olderReply], [olderOtherText, olderOtherReply]]);
      return '어제 요청하신 양손프리 비교는 결제일 기준이었습니다.';
    },
  ], plain);
  assert.match(output.content, /어제 요청하신 양손프리 비교는 결제일 기준/);
  const lookups = s.workerCalls.filter(call => call.path === '/api/discord/conversation/load' && call.body?.olderHistoryOnly);
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].status, 200);
});

test('멘션 채널은 기존 직원별 답장을 유지하고 업무 채널은 대상이 모호할 때 송장을 바꾸지 않습니다', async t => {
  const s = await boot(t), first = await s.start(s.first), second = await s.start(s.other);
  const firstVersion = (await s.get(first.view.run.id)).viewVersion;
  const question = await askForTracking(s, first, `송장 작업 #${first.view.run.id}의 송장 후보를 보여줘`, { channelId: mentionChannel });
  const beforeOtherReply = s.toolRequests.length;
  const crossStaff = await s.invoke(followup, [], { replyToId: question.botMessageId, userId: otherUser, channelId: mentionChannel });
  assert.match(crossStaff.output.content, /답장|작업번호|대화/);
  assert.equal(s.toolRequests.length, beforeOtherReply);

  await askForTracking(s, first, `송장 작업 #${first.view.run.id}의 송장 후보를 보여줘`, plain);
  await askForTracking(s, second, `송장 작업 #${second.view.run.id}의 송장 후보를 보여줘`, { ...plain, userId: otherUser });
  const beforeAmbiguousReply = s.toolRequests.length;
  const ambiguous = await s.invoke(followup, [], plain);
  assert.match(ambiguous.output.content, /상품주문번호|어떤|대상|답장/);
  assert.doesNotMatch(ambiguous.output.content, /#\d+/);
  assert.equal(s.toolRequests.length, beforeAmbiguousReply);
  assert.ok(!s.workerCalls.some(call => /\/tracking$/.test(call.path)));
  assert.equal((await s.get(first.view.run.id)).viewVersion, firstVersion);
  assert.equal((await s.get(second.view.run.id)).viewVersion, second.view.viewVersion);
});

test('이전 답장 이후 웹에서 바뀐 송장 작업은 그대로 보존합니다', async t => {
  const s = await boot(t), target = await s.start(s.first);
  const question = await askForTracking(s, target, `송장 작업 #${target.view.run.id}의 송장 후보를 보여줘`);
  const changed = await s.webNote(target.view);
  assert.notEqual(changed.viewVersion, target.view.viewVersion);

  const reply = await applySecond(s, target, question.botMessageId);
  assert.match(reply.output.content, /바뀌|다시 확인|최신/);
  assert.doesNotMatch(reply.output.content, /두 번째 송장으로 적용했습니다/);
  const current = await s.get(target.view.run.id);
  assert.equal(current.viewVersion, changed.viewVersion);
  assert.equal(current.items[0].note, '웹에서 먼저 수정');
  assert.ok(!s.workerCalls.some(call => /\/tracking$/.test(call.path) && call.body.validateOnly !== true));
});

test('직원이 고른 송장과 모델이 고른 송장이 다르거나 조회만 요청하면 저장하지 않습니다', async t => {
  const s = await boot(t), target = await s.start(s.first), runId = target.view.run.id;
  const question = await askForTracking(s, target, `송장 작업 #${runId}의 송장 후보를 보여줘`);
  for (const [text, trackingNumber] of [
    [followup, target.product.trackingNumber],
    ['두 번째 송장 번호만 알려줘', target.second.trackingNumber],
  ]) {
    const { output } = await s.invoke(text, [
      ['read_invoice', { runId }],
      ['select_invoice_tracking', { runId, trackingNumber, mode: 'replace', productOrderId: target.product.productOrderId }],
      result => { assert.equal(result.ok, false); return '확인 요청입니다.'; },
    ], { replyToId: question.botMessageId });
    assert.match(output.content, /미완료/);
  }
  assert.ok(!s.workerCalls.some(call => /\/tracking$/.test(call.path)));
  assert.equal((await s.get(runId)).viewVersion, target.view.viewVersion);
});

const trackingWrites = calls => calls.filter(call => /\/tracking$/.test(call.path) && call.body.validateOnly !== true);

async function showReprints(s, runId) {
  return s.invoke(`송장 작업 #${runId}의 재출력 송장과 원송장을 보여줘`, [
    ['review_invoice_tracking', { runId, bulkReplacement: false }],
    result => {
      assert.ok(result.trackingRows.every(row => row.originalTrackingNumber && row.reprintTrackingNumber));
      return '원송장과 이번 파일의 송장입니다.';
    },
  ], plain);
}

test('보여준 재출력 네 건에서 원송장을 무시하는 말만으로 새 번호를 일괄 저장하고 엑셀을 받습니다', async t => {
  const extraOrders = [order(3), order(4)];
  const s = await boot(t, { extraOrders });
  const orders = [s.first, s.other, ...extraOrders];
  const { view, reprints } = await s.startReprints(orders), runId = view.run.id;
  const preview = await showReprints(s, runId);
  for (const [i, product] of orders.entries()) {
    assert.ok(preview.output.content.includes(product.trackingNumber));
    assert.ok(preview.output.content.includes(reprints[i].trackingNumber));
  }
  assert.equal(trackingWrites(s.workerCalls).length, 0);

  const done = await s.invoke('그냥 원송장 번호 무시하고 송장번호로 적용해줘. 네이버 업로드용 엑셀도 만들어줘.', [
    (_result, transcript) => {
      assert.deepEqual(suppliedConversation(transcript).pending.trackingGroupKeys, view.trackingReview.groups.map(group => group.key));
      return ['read_invoice', { runId }];
    },
    ['apply_invoice_tracking', { runId, selections: [], all: 'reprint' }],
    result => { assert.equal(result.changed, 4); return ['get_invoice_file', { runId, mode: 'export' }]; },
    result => { assert.equal(result.ok, true); return '이번 파일 송장 네 건을 저장하고 엑셀을 만들었습니다.'; },
  ], { ...plain, userId: otherUser });
  assert.match(done.output.content, /엑셀을 만들었습니다/);
  assert.equal(trackingWrites(s.workerCalls).length, 1);
  const saved = await s.get(runId);
  assert.deepEqual(saved.items.map(item => [item.trackingNumber, item.decision]), reprints.map(parcel => [parcel.trackingNumber, 'include']));
  const book = XLSX.read(done.output.files[0].attachment, { type: 'buffer' });
  const excel = XLSX.utils.sheet_to_json(book.Sheets['발송처리'], { header: 1, raw: true }).slice(1);
  assert.deepEqual(excel.map(row => [row[0], row[3]]), reprints.map(parcel => [parcel.productOrderId, parcel.trackingNumber]));
});

test('목록 번호로 선택한 원송장은 실물 라벨 확인이 필요하고 나머지 선택은 따로 저장합니다', async t => {
  const s = await boot(t);
  const { view, reprints } = await s.startReprints([s.first, s.other]), runId = view.run.id;
  await showReprints(s, runId);
  const earlier = await s.invoke('원송장으로 처리해줘', [
    ['read_invoice', { runId }], ['apply_invoice_tracking', { runId, selections: [], all: 'original' }],
    result => { assert.equal(result.changed, 0); assert.equal(result.blockedSelections.length, 2); return '실제 라벨을 확인해 주세요.'; },
  ], plain);
  assert.match(earlier.output.content, /실제 상자/);
  assert.equal(trackingWrites(s.workerCalls).length, 0);

  const mixed = await s.invoke('1번은 원송장, 2번은 새 송장으로 처리해줘', [
    ['read_invoice', { runId }], ['apply_invoice_tracking', { runId, selections: [{ position: 1, role: 'original' }, { position: 2, role: 'reprint' }], all: null }],
    result => {
      assert.equal(result.changed, 1);
      assert.deepEqual(result.blockedSelections[0].productOrderIds, [s.first.productOrderId]);
      return '두 번째 건을 저장했습니다.';
    },
  ], plain);
  assert.match(mixed.output.content, /완료/);
  assert.match(mixed.output.content, /미완료/);
  assert.equal((await s.get(runId)).items[1].trackingNumber, reprints[1].trackingNumber);

  const original = await s.invoke('1번 실제 박스에 원송장 라벨이 붙어 있어. 1번을 원송장으로 처리해줘.', [
    ['read_invoice', { runId }], ['apply_invoice_tracking', { runId, selections: [{ position: 1, role: 'original' }], all: null }],
    result => { assert.equal(result.changed, 1); assert.equal(result.choices[0].acknowledgeOriginal, true); return '원송장을 적용했습니다.'; },
  ], plain);
  assert.match(original.output.content, /원송장을 적용/);
  assert.deepEqual((await s.get(runId)).items.map(item => item.trackingNumber), [s.first.trackingNumber, reprints[1].trackingNumber]);
  assert.equal(trackingWrites(s.workerCalls).length, 2);
});

test('조회 문장과 오래된 목록은 정정을 실행하지 않고 정확한 상품주문번호별 송장 선택은 한 번에 저장합니다', async t => {
  const s = await boot(t);
  const { view, reprints } = await s.startReprints([s.first, s.other]), runId = view.run.id;
  const requests = reprints.map(parcel => ({ productOrderId: parcel.productOrderId, trackingNumber: parcel.trackingNumber, mode: 'replace' }));
  const readOnly = await s.invoke(`${s.first.productOrderId} 주문의 송장 ${reprints[0].trackingNumber}이 맞는지 확인해줘`, [
    ['read_invoice', { runId }], ['select_invoice_tracking', { runId, ...requests[0] }],
    result => { assert.equal(result.ok, false); return '조회했습니다.'; },
  ], plain);
  assert.match(readOnly.output.content, /변경을 요청한 경우/);
  assert.equal(trackingWrites(s.workerCalls).length, 0);

  const preview = await showReprints(s, runId);
  const changed = await s.webNote(view);
  const stale = await s.invoke('이번 파일 송장으로 처리해줘', [
    ['read_invoice', { runId }], ['apply_invoice_tracking', { runId, selections: [], all: 'reprint' }],
  ], { ...plain, replyToId: preview.botMessageId });
  assert.match(stale.output.content, /작업이 바뀌었습니다/);
  assert.equal((await s.get(runId)).viewVersion, changed.viewVersion);
  assert.equal(trackingWrites(s.workerCalls).length, 0);

  const done = await s.invoke(requests.map(target => `상품주문번호 ${target.productOrderId}의 송장번호를 ${target.trackingNumber}로`).join(', ') + ' 교체해줘', [
    ['read_invoice', { runId }], ['apply_invoice_tracking', { runId, selections: requests, all: null }],
    result => { assert.equal(result.changed, 2); return '두 건의 송장을 저장했습니다.'; },
  ], plain);
  assert.match(done.output.content, /두 건의 송장을 저장/);
  assert.equal(trackingWrites(s.workerCalls).length, 1);
  assert.deepEqual((await s.get(runId)).items.map(item => item.trackingNumber), reprints.map(parcel => parcel.trackingNumber));
});

test('새 목록에서 곧바로 일괄 변경하지 않고 확인 후 현재 연결된 번호를 재출력 번호와 구분합니다', async t => {
  const s = await boot(t);
  const { view, reprints } = await s.startReprints([s.first, s.other]), runId = view.run.id;
  const preview = await s.invoke(`송장 작업 #${runId} 이번 파일 송장으로 처리해줘`, [
    ['read_invoice', { runId }], ['apply_invoice_tracking', { runId, selections: [], all: 'reprint' }],
    result => { assert.equal(result.confirmationRequired, true); return '대상을 확인해 주세요.'; },
  ], plain);
  assert.match(preview.output.content, /아래 목록/);
  assert.equal(trackingWrites(s.workerCalls).length, 0);

  const first = await s.invoke('1번 상자에 붙인 원송장으로 적용해줘', [
    ['read_invoice', { runId }], ['apply_invoice_tracking', { runId, selections: [{ position: 1, role: 'original' }], all: null }],
    result => { assert.equal(result.changed, 1); return '첫 번째 원송장을 적용했습니다.'; },
  ], plain);
  assert.match(first.output.content, /첫 번째 원송장/);

  const second = await s.invoke('현재 연결된 송장으로 처리해줘', [
    ['read_invoice', { runId }], ['apply_invoice_tracking', { runId, selections: [], all: 'current' }],
    result => {
      assert.equal(result.changed, 1);
      assert.equal(result.choices[0].trackingNumber, reprints[1].trackingNumber);
      return '현재 연결된 송장을 적용했습니다.';
    },
  ], plain);
  assert.match(second.output.content, /현재 연결된 송장을 적용/);
  assert.deepEqual((await s.get(runId)).items.map(item => item.trackingNumber), [s.first.trackingNumber, reprints[1].trackingNumber]);
  assert.equal(trackingWrites(s.workerCalls).length, 2);
});
