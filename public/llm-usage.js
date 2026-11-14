'use strict';
const $ = id => document.getElementById(id);
const workDate = (value = Date.now()) => new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const count = value => Number(value || 0).toLocaleString();
const reasons = { unknown_model: '단가 없음', usage_unavailable: '사용량 없음', invalid_usage: '사용량 확인 필요',
  unknown_tier: '요금제 확인 필요', running: '진행 중', invalid_snapshot: '기록 확인 필요' };
const statuses = { succeeded: '성공', failed: '실패', running: '진행 중' };
let trackingStartedAt = null, records = [], recordLimit = 50;
function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (value > 0 && value < 0.000000000001) return '<$0.000000000001';
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: value < 0.000001 ? 12 : 6 });
}
function costCell(row, value, note = '') {
  const cell = row.insertCell(); cell.textContent = money(value); cell.className = 'cost-value';
  if (note) { const reason = document.createElement('small'); reason.className = 'cost-reason'; reason.textContent = note; cell.append(reason); }
}
function message(text, error = false) {
  $('message').textContent = text; $('message').hidden = !text; $('message').classList.toggle('error', error);
  $('message').setAttribute('role', error ? 'alert' : 'status');
}
function setBusy(busy) {
  for (const control of $('usage-form').elements) control.disabled = busy;
  $('show-more-records').disabled = busy;
  $('usage-results').setAttribute('aria-busy', String(busy));
}
async function api(url) {
  const response = await fetch(url), data = await response.json();
  if (!response.ok) throw new Error(data.error || '호출 내역을 조회하지 못했습니다.');
  return data;
}
function showRecords() {
  const body = $('record-rows'); body.replaceChildren();
  for (const record of records.slice(0, recordLimit)) {
    const row = body.insertRow();
    row.insertCell().textContent = new Date(record.startedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    row.insertCell().textContent = record.purposeName;
    row.insertCell().textContent = record.model;
    row.insertCell().textContent = statuses[record.status] || record.status;
    for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens']) row.insertCell().textContent = record[key] == null ? '—' : count(record[key]);
    costCell(row, record.costUsd, record.costUsd == null ? reasons[record.costReason] || '미산정' : '');
  }
  const visible = Math.min(recordLimit, records.length);
  $('record-count').textContent = `${count(records.length)}회`;
  $('visible-record-count').textContent = records.length ? `${count(records.length)}회 중 ${count(visible)}회 표시` : '호출 기록이 없습니다.';
  $('show-more-records').hidden = visible >= records.length;
}
function showUsage(data) {
  trackingStartedAt = data.trackingStartedAt || trackingStartedAt;
  const startDate = trackingStartedAt ? workDate(trackingStartedAt) : null;
  $('tracking-note').textContent = trackingStartedAt
    ? `기록 시작: ${new Date(trackingStartedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · 이 시점 이전의 호출은 기록이 없습니다.`
    : '호출 기록 시작 시점을 확인할 수 없습니다.';
  for (const [id, key] of [['calls-count', 'calls'], ['success-count', 'succeeded'], ['failed-count', 'failed'], ['running-count', 'running']]) {
    $(id).textContent = count(data.totals[key]);
  }
  const beforeRange = startDate && $('date-to').value < startDate;
  const costs = data.costs || { totalUsd: null, averageUsd: null, pricedCalls: 0, unpricedCalls: data.totals.calls, days: [] };
  const hasCalls = Boolean(data.totals.calls), unpriced = Number(costs.unpricedCalls || 0), priced = Number(costs.pricedCalls || 0);
  $('total-cost').textContent = beforeRange ? '—' : money(hasCalls ? costs.totalUsd : 0);
  $('average-cost').textContent = beforeRange || !priced ? '—' : money(costs.averageUsd);
  $('unpriced-count').textContent = beforeRange ? '—' : count(unpriced);
  $('cost-excluded').textContent = !beforeRange && unpriced ? `미산정 ${count(unpriced)}건 제외` : '';
  $('average-basis').textContent = !beforeRange && priced ? `산정된 호출 ${count(priced)}회 기준` : '';
  if (data.pricing?.sourceUrl?.startsWith('https://developers.openai.com/')) $('pricing-source').href = data.pricing.sourceUrl;
  $('pricing-date').textContent = data.pricing?.checkedAt || '—';
  $('pricing-date').dateTime = data.pricing?.checkedAt || '';
  const dailyCosts = new Map((costs.days || []).map(day => [JSON.stringify([day.date, day.purposeCode]), day]));
  const body = $('usage-rows'); body.replaceChildren();
  for (const day of data.days) {
    const row = body.insertRow(), before = startDate && day.date < startDate;
    row.insertCell().textContent = day.date;
    row.insertCell().textContent = day.purposeName;
    for (const key of ['calls', 'succeeded', 'failed', 'running']) row.insertCell().textContent = before ? '—' : count(day[key]);
    const pricedDay = dailyCosts.get(JSON.stringify([day.date, day.purposeCode]));
    const unpricedDay = pricedDay?.unpricedCalls ?? day.calls;
    costCell(row, before ? null : !day.calls ? 0 : pricedDay?.totalUsd,
      !before && day.calls && unpricedDay ? `미산정 ${count(unpricedDay)}건 제외` : '');
    costCell(row, before || !pricedDay?.pricedCalls ? null : pricedDay.averageUsd);
    if (before) row.className = 'before-tracking';
  }
  $('empty-usage').hidden = !!data.totals.calls;
  $('empty-usage').textContent = startDate && $('date-to').value < startDate
    ? '선택한 기간은 호출 기록 시작 이전입니다. 과거 호출 횟수는 확인할 수 없습니다.'
    : '선택한 기간에 기록된 AI 호출이 없습니다. 기존 이름 재사용은 AI 호출에 포함되지 않습니다.';
  records = data.records || []; recordLimit = 50; showRecords();
  $('usage-results').hidden = false;
}
async function loadUsage() {
  if ($('date-from').value > $('date-to').value) { $('usage-results').hidden = true; message('시작 날짜는 종료 날짜보다 늦을 수 없습니다.', true); return; }
  const query = new URLSearchParams({ from: $('date-from').value, to: $('date-to').value });
  if ($('purpose').value) query.set('purpose', $('purpose').value);
  setBusy(true); $('usage-results').hidden = true; message('호출 내역을 조회하고 있습니다.');
  try { showUsage(await api(`/api/llm/usage?${query}`)); message(''); }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
$('usage-form').addEventListener('submit', event => { event.preventDefault(); loadUsage(); });
$('show-more-records').addEventListener('click', () => { recordLimit += 50; showRecords(); });
async function start() {
  const today = workDate(); $('date-from').value = `${today.slice(0, 7)}-01`; $('date-to').value = today;
  setBusy(true);
  try {
    const data = await api('/api/llm/purposes'); trackingStartedAt = data.trackingStartedAt;
    for (const purpose of data.purposes) $('purpose').add(new Option(`${purpose.name}${purpose.active ? '' : ' (중지)'}`, purpose.code));
    await loadUsage();
  } catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
start();
