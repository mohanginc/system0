import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createDiscordHandler } from '../lib/discord-bot.mjs';
import { courierFile, naverFile, sourceFile } from './fixtures/weekend-invoices.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), 'absent-system0-' + randomUUID());
process.env.DISCORD_ENV_FILE = path.join(os.tmpdir(), 'absent-discord-' + randomUUID());
const { createApp } = await import('../server.mjs');

const date = '2026-11-16';
const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const otherUser = '444444444444444444';
const config = { secret: 'conversation-local-test-secret', guildId: scope.guildId, channelIds: [scope.channelId],
  userIds: [scope.userId, otherUser], publicOrigin: 'https://system0.example' };
const order = n => ({ productOrderId: '2026111600000000' + n, orderId: '2026111600000009' + n,
  internalId: '00000' + n, trackingNumber: '0455000000' + n, productName: '가상 제품 ' + n, optionName: String(n),
  recipient: '가상 수취인', phone: '010-0000-0000', address: '서울 가상 주소 101호', quantity: 1 });
const secondNumber = '04550000009';
const followup = '재출력이야. 두 번째 송장으로 적용해줘';
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function boot(t) {
  const toolRequests = [], workerCalls = [];
  let nextTurn;
  const client = { responses: { create: async request => {
    assert.equal(request.store, false);
    const transcript = JSON.stringify({ input: request.input, instructions: request.instructions });
    for (const value of [config.secret, '가상 수취인', '010-0000-0000', '서울 가상 주소 101호']) assert.ok(!transcript.includes(value), value);
    toolRequests.push(transcript);
    const outputs = request.input.filter(entry => entry.type === 'function_call_output').map(entry => JSON.parse(entry.output));
    const [action, args] = nextTurn(outputs, transcript) || [];
    assert.ok(action, '예상한 순서로만 도구를 호출합니다.');
    if (!args) return { output_text: action };
    assert.ok(request.tools.some(value => value.name === action));
    const call_id = 'call_conversation_' + toolRequests.length;
    return { output: [{ type: 'function_call', id: 'fc_' + toolRequests.length, call_id, name: action, arguments: JSON.stringify(args) }] };
  } } };
  const app = createApp({ databasePath: ':memory:', apiKey: '', client, model: 'mock-local', discordConfig: config });
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
  formFile(source, 'files', sourceFile([first, other]));
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
  let eventId = 666666666666666660n;
  async function invoke(text, steps, { replyToId = null, userId = scope.userId } = {}) {
    const botMessageId = String(eventId++);
    nextTurn = (outputs, transcript) => {
      const step = steps[outputs.length];
      assert.ok(step, '이 요청에서는 추가 모델 호출이 없어야 합니다.');
      const value = typeof step === 'function' ? step(outputs.at(-1), transcript) : step;
      return Array.isArray(value) ? value : [value];
    };
    const output = await handle({ ...scope, userId, id: String(eventId++), kind: 'message', text, botMessageId, replyToId });
    return { output, botMessageId };
  }
  const get = runId => request('/api/invoices/' + runId);
  const webNote = view => request(`/api/invoices/${view.run.id}/items`, json('PATCH', { expectedVersion: view.viewVersion,
    changes: [{ id: view.items[0].id, decision: view.items[0].decision, note: '웹에서 먼저 수정' }] }));
  return { first, other, start, invoke, get, webNote, toolRequests, workerCalls };
}

function askForTracking(s, target, text) {
  return s.invoke(text, [
    ['review_invoice_tracking', { runId: target.view.run.id, bulkReplacement: false }],
    result => {
      assert.equal(result.ok, true);
      assert.equal(result.trackingGroups.length, 1);
      return `송장 작업 #${target.view.run.id}의 두 후보입니다. 첫 번째 ${target.product.trackingNumber}, 두 번째 ${target.second.trackingNumber}. 재출력인지 분리 배송인지 알려주세요.`;
    },
  ]);
}

function applySecond(s, target, replyToId, onRead) {
  const runId = target.view.run.id;
  return s.invoke(followup, [
    (result, transcript) => {
      onRead?.(transcript);
      return ['read_invoice', { runId }];
    },
    ['select_invoice_tracking', { runId, productOrderId: target.product.productOrderId,
      trackingNumber: target.second.trackingNumber, mode: 'replace' }],
    result => result.ok ? '두 번째 송장으로 적용했습니다.' : '앞의 선택은 적용하지 못했습니다.',
  ], { replyToId });
}

test('봇 답장으로 한 업무의 송장 후보를 이어받아 웹에 두 번째 송장을 저장합니다', async t => {
  const s = await boot(t), target = await s.start(s.first), unrelated = await s.start(s.other);
  const firstText = `오전 재출력 문의입니다. 송장 작업 #${target.view.run.id}에서 송장 후보를 확인해줘`;
  const first = await askForTracking(s, target, firstText);
  assert.match(first.output.content, /재출력인지 분리 배송인지/);
  const unrelatedText = `다른 포장 확인입니다. 송장 작업 #${unrelated.view.run.id}의 상태만 알려줘`;
  await s.invoke(unrelatedText, [
    (result, transcript) => {
      assert.ok(!transcript.includes(firstText));
      return ['read_invoice', { runId: unrelated.view.run.id }];
    },
    '다른 포장 주문의 상태를 확인했습니다.',
  ]);

  const current = await applySecond(s, target, first.botMessageId, transcript => {
    assert.ok(transcript.includes(firstText));
    assert.ok(transcript.includes(`두 번째 ${target.second.trackingNumber}`));
    assert.ok(!transcript.includes(unrelatedText));
    assert.ok(!transcript.includes('다른 포장 주문의 상태를 확인했습니다.'));
  });
  assert.match(current.output.content, /두 번째 송장으로 적용했습니다/);
  const after = await s.get(target.view.run.id);
  assert.equal(after.items[0].trackingNumber, target.second.trackingNumber);
  assert.equal(after.items[0].trackingSelection.mode, 'replace');
  assert.equal((await s.get(unrelated.view.run.id)).viewVersion, unrelated.view.viewVersion);
  const mutations = s.workerCalls.filter(call => call.path === `/api/invoices/${target.view.run.id}/tracking`);
  assert.deepEqual(mutations.map(call => [call.body.validateOnly === true, call.status]), [[true, 200], [false, 200]]);
});

test('다른 직원의 답장과 대상이 모호한 후속 요청은 이전 대화나 송장을 사용하지 않습니다', async t => {
  const s = await boot(t), first = await s.start(s.first), second = await s.start(s.other);
  const firstVersion = (await s.get(first.view.run.id)).viewVersion;
  const question = await askForTracking(s, first, `송장 작업 #${first.view.run.id}의 송장 후보를 보여줘`);
  const beforeOtherReply = s.toolRequests.length;
  const crossStaff = await s.invoke(followup, [], { replyToId: question.botMessageId, userId: otherUser });
  assert.match(crossStaff.output.content, /답장|작업번호|대화/);
  assert.equal(s.toolRequests.length, beforeOtherReply);

  await askForTracking(s, second, `송장 작업 #${second.view.run.id}의 송장 후보를 보여줘`);
  const beforeAmbiguousReply = s.toolRequests.length;
  const ambiguous = await s.invoke(followup, []);
  assert.match(ambiguous.output.content, /작업번호|어떤|대상|답장/);
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
