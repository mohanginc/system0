import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../lib/database.mjs';
import { callLlm, llmUsage } from '../lib/llm.mjs';

const model = 'gpt-6.1-sol';
const usage = (input = 1000, output = 100, cached = 0, write = 0, details) => ({ input_tokens: input, output_tokens: output,
  input_tokens_details: { cached_tokens: cached, cache_write_tokens: write, ...(details ? { cache_write_tokens_details: details } : {}) },
  output_tokens_details: { reasoning_tokens: 80 }, total_tokens: input + output });
const near = (actual, expected) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-11, `${actual} != ${expected}`);
const today = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const view = db => llmUsage(db, today(), today());
async function completed(db, response, request = {}) {
  return callLlm(db, { purposeCode: 'product_names', itemCount: 1 }, { responses: { create: async () => ({ model, ...response }) } }, { model, ...request });
}
function memory(t) { const db = openDatabase(':memory:'); t.after(() => db.close()); return db; }

test('실제 캐시 읽기·쓰기·출력 토큰으로 호출비를 계산하고 추론 토큰을 중복 청구하지 않는다', async t => {
  const db = memory(t);
  await completed(db, { usage: usage(3928, 679, 1675, 2250), service_tier: 'default' });
  const result = view(db), expected = (3 * 2 + 1675 * 0.1 + 2250 * 2.5 + 679 * 10) / 1e6;
  near(result.records[0].costUsd, expected); near(result.costs.totalUsd, expected); near(result.costs.averageUsd, expected);
  assert.equal(result.records[0].cachedInputTokens, 1675); assert.equal(result.records[0].cacheWriteTokens, 2250);
  assert.equal(result.records[0].pricingBasis, 'recorded'); assert.equal(result.costs.pricedCalls, 1);
  assert.equal(result.pricing.currency, 'USD'); assert.equal(result.pricing.checkedAt, '2026-11-14');
  const saved = JSON.parse(db.prepare('SELECT cost_json FROM llm_calls').get().cost_json);
  near(saved.costUsd, expected); assert.equal(saved.ratesPerMillion.cacheWrite30m, 2.5);
});

test('응답의 실제 처리 등급과 긴 입력·12시간 캐시쓰기 단가를 적용한다', async t => {
  const db = memory(t);
  await completed(db, { usage: usage(300000, 100, 1000, 2000, { ttl_30m_tokens: 500, ttl_12h_tokens: 1500 }), service_tier: 'priority' }, { service_tier: 'default' });
  const expected = ((297000 * 2 + 1000 * 0.1 + 500 * 2.5 + 1500 * 5) * 2 * 2 + 100 * 10 * 1.5 * 2) / 1e6;
  near(view(db).records[0].costUsd, expected);
  await completed(db, { usage: usage(), service_tier: 'flex' });
  near(view(db).records.find(row => row.id === 2).costUsd, (1000 * 2 + 100 * 10) * 0.5 / 1e6);
});

test('응답 검증 실패도 사용량이 있으면 산정하고 통신 실패·진행 중은 합계의 0원으로 취급하지 않는다', async t => {
  const db = memory(t);
  await assert.rejects(callLlm(db, { purposeCode: 'product_names', itemCount: 1 },
    { responses: { create: async () => ({ model, usage: usage() }) } }, { model }, () => { throw new Error('검증 실패'); }));
  await assert.rejects(callLlm(db, { purposeCode: 'product_names', itemCount: 1 },
    { responses: { create: async () => { throw new Error('통신 실패'); } } }, { model }));
  db.prepare('INSERT INTO llm_calls(purpose_code,model,item_count,started_at) VALUES(?,?,?,?)').run('product_names', model, 1, new Date().toISOString());
  const result = view(db);
  assert.equal(result.totals.failed, 2); assert.equal(result.totals.running, 1);
  near(result.costs.totalUsd, 0.003); near(result.costs.averageUsd, 0.003);
  assert.equal(result.costs.pricedCalls, 1); assert.equal(result.costs.unpricedCalls, 2);
  assert.equal(result.records.find(row => row.id === 2).costUsd, null);
  assert.equal(result.records.find(row => row.id === 3).costReason, 'running');
});

test('알 수 없는 모델·누락·잘못된 토큰·요금 등급은 미산정이며 유효한 0토큰만 0원이다', async t => {
  const db = memory(t);
  for (const response of [{ model: 'unknown-model', usage: usage() }, { usage: null },
    { usage: usage(100, 10, 90, 20) }, { usage: { input_tokens: 100, output_tokens: 10 } },
    { usage: usage(), service_tier: 'scale' }]) await completed(db, response);
  const missing = view(db); assert.equal(missing.costs.totalUsd, null); assert.equal(missing.costs.pricedCalls, 0);
  assert.ok(missing.records.every(row => row.costUsd === null));
  await completed(db, { usage: usage(0, 0) });
  assert.equal(view(db).records.find(row => row.id === 6).costUsd, 0);
  assert.equal(view(db).costs.averageUsd, 0);
});

test('과거 사용량은 현재 Standard 단가로 읽기만 계산하고 날짜·목적 비용을 같은 범위로 집계한다', t => {
  const db = memory(t);
  db.prepare('INSERT INTO llm_purposes(code,name) VALUES(?,?)').run('other_cost', '가상 다른 업무');
  const insert = db.prepare(`INSERT INTO llm_calls(purpose_code,model,item_count,status,started_at,usage_json) VALUES(?,?,1,'succeeded',?,?)`);
  insert.run('product_names', model, '2026-11-12T15:00:00.000Z', JSON.stringify(usage()));
  insert.run('other_cost', model, '2026-11-13T14:59:59.999Z', JSON.stringify(usage(2000)));
  insert.run('product_names', model, '2026-11-13T15:00:00.000Z', JSON.stringify(usage(5000)));
  const before = db.prepare('SELECT * FROM llm_calls').all();
  const result = llmUsage(db, '2026-11-13', '2026-11-13', 'product_names');
  assert.equal(result.records.length, 1); assert.equal(result.records[0].pricingBasis, 'current_standard');
  near(result.costs.totalUsd, 0.003); assert.equal(result.costs.days.find(row => row.purposeCode === 'product_names').pricedCalls, 1);
  assert.deepEqual(db.prepare('SELECT * FROM llm_calls').all(), before);
});

test('호출 당시 저장한 단가·비용은 재시작 후에도 보존한다', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-cost-')), filename = path.join(directory, 'calls.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let db = openDatabase(filename);
  await completed(db, { usage: usage(), service_tier: 'default' });
  const saved = db.prepare('SELECT cost_json FROM llm_calls').get().cost_json; db.close();
  db = openDatabase(filename); assert.equal(db.prepare('SELECT cost_json FROM llm_calls').get().cost_json, saved);
  near(view(db).records[0].costUsd, 0.003); db.close();
});
