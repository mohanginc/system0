'use strict';
const $ = id => document.getElementById(id);
const workDate = (value = Date.now()) => new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const count = value => Number(value || 0).toLocaleString();
let trackingStartedAt = null;
function message(text, error = false) {
  $('message').textContent = text; $('message').hidden = !text; $('message').classList.toggle('error', error);
}
function setBusy(busy) {
  for (const control of $('usage-form').elements) control.disabled = busy;
  $('usage-results').setAttribute('aria-busy', String(busy));
}
async function api(url) {
  const response = await fetch(url), data = await response.json();
  if (!response.ok) throw new Error(data.error || '호출 내역을 조회하지 못했습니다.');
  return data;
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
  const body = $('usage-rows'); body.replaceChildren();
  for (const day of data.days) {
    const row = body.insertRow(), before = startDate && day.date < startDate;
    row.insertCell().textContent = day.date;
    row.insertCell().textContent = day.purposeName;
    for (const key of ['calls', 'succeeded', 'failed', 'running']) row.insertCell().textContent = before ? '—' : count(day[key]);
    if (before) row.className = 'before-tracking';
  }
  $('empty-usage').hidden = !!data.totals.calls;
  $('empty-usage').textContent = startDate && $('date-to').value < startDate
    ? '선택한 기간은 호출 기록 시작 이전입니다. 과거 호출 횟수는 확인할 수 없습니다.'
    : '선택한 기간에 기록된 AI 호출이 없습니다. 기존 이름 재사용은 AI 호출에 포함되지 않습니다.';
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
