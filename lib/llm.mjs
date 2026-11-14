import { quoteLlmCost, recordedCost, costSummary, pricingInfo } from './llm-pricing.mjs';

export function listLlmPurposes(db) {
  return {
    trackingStartedAt: db.prepare("SELECT value FROM app_metadata WHERE key = 'llm_tracking_started_at'").get().value,
    purposes: db.prepare('SELECT code, name, active FROM llm_purposes ORDER BY code').all()
      .map(purpose => ({ ...purpose, active: Boolean(purpose.active) })),
  };
}

export async function callLlm(db, { purposeCode, batchId = null, itemCount }, client, request, validate) {
  if (!db.prepare('SELECT code FROM llm_purposes WHERE code = ? AND active = 1').get(purposeCode)) {
    throw new Error('사용할 AI 업무 목적을 확인해 주세요.');
  }
  const id = Number(db.prepare(`INSERT INTO llm_calls (purpose_code, batch_id, model, item_count, started_at)
    VALUES (?, ?, ?, ?, ?)`).run(purposeCode, batchId, request.model, itemCount, new Date().toISOString()).lastInsertRowid);
  const finish = db.prepare('UPDATE llm_calls SET status = ?, finished_at = ?, usage_json = ?, model = ?, error_code = ?, cost_json = ? WHERE id = ?');
  const cost = response => JSON.stringify(quoteLlmCost(response?.model || request.model, response?.usage,
    { serviceTier: response?.service_tier || request.service_tier, cacheTtl: request.prompt_cache_options?.ttl || '30m' }));
  let response;
  try {
    response = await client.responses.create(request);
    const result = validate ? validate(response) : response;
    finish.run('succeeded', new Date().toISOString(), response.usage ? JSON.stringify(response.usage) : null,
      response.model || request.model, null, cost(response), id);
    return result;
  } catch (error) {
    finish.run('failed', new Date().toISOString(), response?.usage ? JSON.stringify(response.usage) : null,
      response?.model || request.model, String(error.code || error.status || error.name || 'error').slice(0, 100), cost(response), id);
    throw error;
  }
}

export function llmUsage(db, from, to, purpose) {
  const dateValue = value => {
    const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000')
      ? new Date(`${value}T00:00:00.000Z`) : new Date(NaN);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error('조회 날짜는 실제 존재하는 날짜를 YYYY-MM-DD 형식으로 지정해 주세요.');
    }
    return date.getTime();
  };
  const start = dateValue(from), end = dateValue(to);
  if (start > end) throw new Error('시작 날짜는 종료 날짜보다 늦을 수 없습니다.');
  if (purpose !== undefined && typeof purpose !== 'string') throw new Error('조회할 업무 목적을 확인해 주세요.');
  const { trackingStartedAt, purposes } = listLlmPurposes(db);
  const selected = purpose ? purposes.filter(item => item.code === purpose) : purposes;
  if (!selected.length) throw new Error('조회할 업무 목적을 찾을 수 없습니다.');
  if (((end - start) / (24 * 60 * 60 * 1000) + 1) * selected.length > 10000) {
    throw new Error('조회 기간과 업무 목적을 줄여 주세요. 날짜·목적별 결과는 10,000행까지 조회할 수 있습니다.');
  }
  const offset = 9 * 60 * 60 * 1000;
  const counts = db.prepare(`SELECT date(started_at, '+9 hours') AS date, purpose_code AS purposeCode,
    count(*) AS calls, sum(status = 'succeeded') AS succeeded, sum(status = 'failed') AS failed,
    sum(status = 'running') AS running FROM llm_calls
    WHERE started_at >= ? AND started_at < ?${purpose ? ' AND purpose_code = ?' : ''}
    GROUP BY date, purpose_code`).all(new Date(start - offset).toISOString(),
    new Date(end + 24 * 60 * 60 * 1000 - offset).toISOString(), ...(purpose ? [purpose] : []));
  const indexed = new Map(counts.map(row => [JSON.stringify([row.date, row.purposeCode]), row]));
  const days = [], totals = { calls: 0, succeeded: 0, failed: 0, running: 0 };
  for (let time = start; time <= end; time += 24 * 60 * 60 * 1000) {
    const date = new Date(time).toISOString().slice(0, 10);
    for (const item of selected) {
      const row = { date, purposeCode: item.code, purposeName: item.name, calls: 0, succeeded: 0, failed: 0, running: 0,
        ...indexed.get(JSON.stringify([date, item.code])) };
      days.push(row);
      for (const key of Object.keys(totals)) totals[key] += row[key];
    }
  }
  const records = db.prepare(`SELECT c.id,c.started_at AS startedAt,c.purpose_code AS purposeCode,p.name AS purposeName,
    c.model,c.status,c.usage_json,c.cost_json,date(c.started_at,'+9 hours') AS date FROM llm_calls c
    JOIN llm_purposes p ON p.code=c.purpose_code WHERE c.started_at>=? AND c.started_at<?${purpose ? ' AND c.purpose_code=?' : ''}
    ORDER BY c.started_at DESC,c.id DESC`).all(new Date(start - offset).toISOString(),
    new Date(end + 24 * 60 * 60 * 1000 - offset).toISOString(), ...(purpose ? [purpose] : [])).map(row => {
      const cost = recordedCost(row);
      return { id: row.id, startedAt: row.startedAt, date: row.date, purposeCode: row.purposeCode, purposeName: row.purposeName,
        model: row.model, status: row.status, inputTokens: cost.inputTokens ?? null, outputTokens: cost.outputTokens ?? null,
        cachedInputTokens: cost.cachedInputTokens ?? null, cacheWriteTokens: cost.cacheWriteTokens ?? null,
        costUsd: cost.costUsd, costReason: cost.costReason || null, pricingBasis: cost.pricingBasis };
    });
  const costsByDay = new Map();
  for (const row of records) {
    const key = JSON.stringify([row.date, row.purposeCode]);
    if (!costsByDay.has(key)) costsByDay.set(key, []);
    costsByDay.get(key).push(row);
  }
  return { trackingStartedAt, days, totals, pricing: pricingInfo, records,
    costs: { currency: 'USD', ...costSummary(records), days: days.map(day => ({ date: day.date, purposeCode: day.purposeCode,
      ...costSummary(costsByDay.get(JSON.stringify([day.date, day.purposeCode])) || []) })) } };
}
