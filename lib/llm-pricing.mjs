export const pricingInfo = Object.freeze({ currency: 'USD', checkedAt: '2026-11-14',
  sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol' });
const rates = Object.freeze({ 'gpt-6.1-sol': { input: 2, cachedInput: 0.1, cacheWrite30m: 2.5, cacheWrite12h: 5, output: 10 } });
const tiers = { default: 1, flex: 0.5, priority: 2, fast: 2, ultrafast: 6 };
const tokenCount = value => Number.isSafeInteger(value) && value >= 0;
const nullableCount = value => tokenCount(value) ? value : null;
export const roundCost = value => Number(value.toFixed(10));

export function quoteLlmCost(model, usage, { serviceTier, cacheTtl = '30m' } = {}) {
  const details = usage?.input_tokens_details;
  const quote = { schemaVersion: 1, ...pricingInfo, model, serviceTier: serviceTier || 'default',
    assumedServiceTier: !serviceTier || serviceTier === 'auto',
    inputTokens: nullableCount(usage?.input_tokens), outputTokens: nullableCount(usage?.output_tokens),
    cachedInputTokens: nullableCount(details?.cached_tokens), cacheWriteTokens: nullableCount(details?.cache_write_tokens),
    costUsd: null, costReason: null };
  const fail = reason => ({ ...quote, costReason: reason });
  const price = Object.hasOwn(rates, model) ? rates[model] : null;
  if (!price) return fail('unknown_model');
  if (!usage || usage.input_tokens === undefined || usage.output_tokens === undefined) return fail('usage_unavailable');
  if (quote.inputTokens === null || quote.outputTokens === null) return fail('invalid_usage');
  const cached = details?.cached_tokens ?? (quote.inputTokens === 0 ? 0 : null);
  const written = details?.cache_write_tokens ?? (quote.inputTokens === 0 ? 0 : null);
  if (!tokenCount(cached) || !tokenCount(written) || cached + written > quote.inputTokens) return fail('invalid_usage');
  if (usage.total_tokens !== undefined && (!tokenCount(usage.total_tokens) || usage.total_tokens !== quote.inputTokens + quote.outputTokens)) return fail('invalid_usage');
  const tier = serviceTier && serviceTier !== 'auto' ? serviceTier : 'default';
  if (!Object.hasOwn(tiers, tier)) return fail('unknown_tier');
  let shortWrites = written, longWrites = 0;
  const writes = details?.cache_write_tokens_details;
  if (writes) {
    if (!tokenCount(writes.ttl_30m_tokens) || !tokenCount(writes.ttl_12h_tokens)
      || writes.ttl_30m_tokens + writes.ttl_12h_tokens !== written) return fail('invalid_usage');
    shortWrites = writes.ttl_30m_tokens; longWrites = writes.ttl_12h_tokens;
  } else if (cacheTtl === '12h') { shortWrites = 0; longWrites = written; }
  else if (written && cacheTtl !== '30m') return fail('unknown_tier');
  const longContext = quote.inputTokens > 272000;
  const inputCost = ((quote.inputTokens - cached - written) * price.input + cached * price.cachedInput
    + shortWrites * price.cacheWrite30m + longWrites * price.cacheWrite12h) * (longContext ? 2 : 1);
  const outputCost = quote.outputTokens * price.output * (longContext ? 1.5 : 1);
  return { ...quote, serviceTier: tier, cachedInputTokens: cached, cacheWriteTokens: written,
    cacheWrite30mTokens: shortWrites, cacheWrite12hTokens: longWrites, longContext, ratesPerMillion: { ...price },
    costUsd: roundCost((inputCost + outputCost) * tiers[tier] / 1e6) };
}

export function recordedCost(row) {
  if (row.status === 'running') return { inputTokens: null, outputTokens: null, cachedInputTokens: null,
    cacheWriteTokens: null, costUsd: null, costReason: 'running', pricingBasis: 'current_standard' };
  if (row.cost_json) {
    try {
      const saved = JSON.parse(row.cost_json);
      if (saved.schemaVersion !== 1 || saved.currency !== 'USD'
        || (saved.costUsd !== null && (typeof saved.costUsd !== 'number' || !Number.isFinite(saved.costUsd) || saved.costUsd < 0))) throw Error();
      return { ...saved, pricingBasis: 'recorded' };
    } catch { return { costUsd: null, costReason: 'invalid_snapshot', pricingBasis: 'recorded' }; }
  }
  let usage;
  try { usage = row.usage_json ? JSON.parse(row.usage_json) : null; }
  catch { return { costUsd: null, costReason: 'invalid_usage', pricingBasis: 'current_standard' }; }
  return { ...quoteLlmCost(row.model, usage), pricingBasis: 'current_standard' };
}

export function costSummary(records) {
  const priced = records.filter(record => record.costUsd !== null), sum = priced.reduce((total, record) => total + record.costUsd, 0);
  return { totalUsd: priced.length ? roundCost(sum) : records.length ? null : 0,
    averageUsd: priced.length ? roundCost(sum / priced.length) : null,
    pricedCalls: priced.length, unpricedCalls: records.length - priced.length };
}
