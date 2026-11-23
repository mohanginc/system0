import test from 'node:test';
import assert from 'node:assert/strict';
import { runDiscordAgent } from '../lib/discord-invoice-agent.mjs';

const privateText = 'private-model-or-order-value';
const step = (name, args, id = name) => ({ output: [{ type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) }] });
const final = { text: privateText };

function run(steps, trace, otherApi = async route => { assert.fail(`예상하지 않은 API: ${route}`); }) {
  return runDiscordAgent({ text: privateText, scope: {}, today: '2026-11-23', attachments: [], trace, json: (_method, body) => body,
    api: (route, options) => {
      if (route !== '/api/discord/agent-step') return otherApi(route, options);
      const response = steps.shift();
      if (response instanceof Error) throw response;
      return response;
    } });
}

test('업무 도구 추적은 입력 범위·결과 건수·실행 거절을 남기고 원문은 포함하지 않는다', async () => {
  const events = [];
  const changes = Array.from({ length: 10 }, (_, i) => ({ productOrderId: `202611230000000${i}`, decision: 'hold', note: privateText }));
  const result = await run([
    step('read_order_batch', { batchId: 73, query: privateText, offset: 0 }),
    step('save_invoice_review', { runId: 19, changes, warnings: [] }), final,
  ], event => events.push(event), async route => {
    assert.equal(route, '/api/batches/73');
    return { batch: { id: 73, filename: privateText }, summary: { total: 1, confirmed: 1, note: privateText },
      rows: [{ id: 1, originalName: privateText, reviewNote: privateText, status: 'confirmed' }] };
  });
  assert.match(result.content, /완료[\s\S]*미완료/);
  assert.deepEqual(events.map(event => event.stage), ['agent.tool.start', 'agent.tool.result', 'agent.tool.start', 'agent.tool.result', 'agent.finished']);
  assert.deepEqual(events[0].arguments, { batchId: 73, offset: 0, querySpecified: true });
  assert.deepEqual(events[1].result, { batchId: 73, matchingRows: 1, summary: { total: 1, confirmed: 1 }, rowsCount: 1 });
  assert.equal(events[1].outcome, 'succeeded');
  assert.equal(events[2].arguments.changesCount, 10);
  assert.deepEqual(events[2].arguments.changes, changes.slice(0, 8).map(({ productOrderId, decision }) => ({ productOrderId, decision })));
  assert.equal(events[3].reason, 'read_required');
  assert.equal(events[4].outcome, 'partial');
  assert.equal(events[4].reportCount, 1);
  assert.equal(events[4].unfinishedCount, 1);
  assert.ok(!JSON.stringify(events).includes(privateText));
});

test('업무 도구의 부분 결과와 잘못된 도구 요청을 구분해 기록한다', async () => {
  const events = [];
  await run([
    step('check_invoice_registration', { date: '2026-11-23' }),
    { output: [{ type: 'function_call', name: 'get_invoice_file', call_id: 'invalid', arguments: privateText }] },
    step(privateText, { text: privateText }), final,
  ], event => events.push(event), async (route, body) => {
    assert.equal(route, '/api/invoices/check-date');
    assert.equal(body.date, '2026-11-23');
    return { runIds: Array.from({ length: 12 }, (_, i) => i + 1), summary: { succeeded: 2, failed: 1 },
      errors: [{ error: privateText, attachment: Buffer.from(privateText) }] };
  });
  assert.equal(events[1].outcome, 'partial');
  assert.deepEqual(events[1].result, { date: '2026-11-23', summary: { succeeded: 2, failed: 1 },
    errorsCount: 1, runIdsCount: 12, runIds: [1, 2, 3, 4, 5, 6, 7, 8] });
  assert.equal(events[3].reason, 'invalid_tool_json');
  assert.equal(events[4].tool, 'unknown');
  assert.equal(events[5].reason, 'unknown_tool');
  assert.ok(!JSON.stringify(events).includes(privateText));
});

test('도구 없는 응답과 모델 호출 실패를 구분하며 추적 기록 실패는 응답에 영향을 주지 않는다', async () => {
  const events = [];
  const normal = await run([final], event => {
    events.push(event);
    return Promise.reject(new Error('기록 실패'));
  });
  assert.equal(normal.content, privateText);
  assert.equal(events[0].outcome, 'no_work');
  assert.equal(events[0].reason, 'no_tool_selected');
  assert.equal(events[0].toolAttempts, 0);
  await run([Object.assign(new Error(privateText), { status: 503 })], event => events.push(event));
  assert.deepEqual(events[1], { stage: 'agent.step.failed', step: 1, reason: 'model_step_failed', status: 503 });
  assert.equal(events[2].outcome, 'incomplete');
  assert.equal(events[2].reason, 'model_step_failed');
  assert.ok(!JSON.stringify(events).includes(privateText));
});
