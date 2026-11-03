'use strict';
const $ = id => document.getElementById(id);
const workDate = (value = Date.now()) => new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const count = value => Number(value || 0).toLocaleString('ko-KR');
let selectedDate = workDate(), calendarMonth = selectedDate.slice(0, 7), selectedBatchId = null;
let calendarData = { days: [] }, boardData = null, busy = false;
let mode = 'confirmed', previewData = null;
const messages = { confirmed: { text: '', error: false }, new: { text: '', error: false } };
const formatTime = value => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const invoiceState = state => ['unavailable', 'pending', 'complete'].includes(state) ? state : 'unavailable';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, error = false) {
  messages[mode] = { text, error };
  $('board-message').textContent = text;
  $('board-message').hidden = !text;
  $('board-message').classList.toggle('error', error);
}
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll('.board-sidebar button, .board-modes button, #refresh-button')) button.disabled = value;
  $('shipment-groups').setAttribute('aria-busy', String(value));
  $('refresh-button').textContent = value ? (mode === 'new' ? '조회·상품명 정리 중…' : '조회 중…') : (mode === 'new' ? '갱신' : '새로고침');
}
async function api(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(options.method === 'POST' ? 300000 : 15000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '출고 목록을 조회하지 못했습니다.');
  return data;
}
function renderCalendar() {
  const [year, month] = calendarMonth.split('-').map(Number);
  $('month-title').textContent = `${year}년 ${month}월`;
  const days = new Map(calendarData.days.map(day => [day.date, day]));
  const firstDay = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < firstDay; index++) fragment.append(element('span'));
  for (let day = 1; day <= lastDay; day++) {
    const date = `${calendarMonth}-${String(day).padStart(2, '0')}`, record = days.get(date);
    const button = element('button', String(day), 'calendar-day');
    button.type = 'button'; button.dataset.date = date; button.disabled = busy;
    button.classList.toggle('is-today', date === workDate());
    button.classList.toggle('has-jobs', Boolean(record?.batchCount));
    button.dataset.invoiceState = invoiceState(record?.invoiceState);
    button.setAttribute('aria-pressed', String(date === selectedDate));
    button.setAttribute('aria-label', `${year}년 ${month}월 ${day}일${record?.batchCount ? `, 작업 ${record.batchCount}개` : ', 작업 없음'}`);
    button.addEventListener('click', () => { if (!busy) selectDay(date); });
    fragment.append(button);
  }
  $('calendar-days').replaceChildren(fragment);
}
function renderJobs(data) {
  $('job-count').textContent = `${count(data.batches.length)}개`;
  const fragment = document.createDocumentFragment();
  if (!data.batches.length) fragment.append(element('p', '이 날짜에 저장된 작업이 없습니다.', 'job-empty'));
  else {
    const all = element('button', undefined, 'job-button'); all.type = 'button'; all.dataset.batchId = '';
    all.setAttribute('aria-pressed', String(selectedBatchId === null));
    all.append(element('strong', '모든 작업 모아 보기'), element('small', `작업 ${count(data.batches.length)}개`));
    all.addEventListener('click', () => selectBatch(null)); fragment.append(all);
    for (const batch of data.batches) {
      const button = element('button', undefined, 'job-button'); button.type = 'button'; button.dataset.batchId = String(batch.id);
      button.setAttribute('aria-pressed', String(selectedBatchId === batch.id));
      const time = new Date(batch.createdAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
      button.append(element('strong', batch.name), element('small', `${time} · 주문 ${count(batch.rowCount)}행`));
      button.addEventListener('click', () => selectBatch(batch.id)); fragment.append(button);
    }
  }
  $('job-list').replaceChildren(fragment);
}
function renderGroup(group, open, preview = false) {
  const complete = invoiceState(group.invoiceState) === 'complete' && !group.unprepared && !group.needsAttention;
  const details = element('details', undefined, 'shipment-card'); details.dataset.key = group.key;
  details.dataset.invoiceState = invoiceState(group.invoiceState); details.open = open;
  details.classList.toggle('is-complete', complete); details.classList.toggle('is-unprepared', Boolean(group.unprepared));
  details.classList.toggle('is-attention', Boolean(group.needsAttention));
  const summary = element('summary'), name = element('div', undefined, 'shipment-name');
  name.append(element('h2', group.name || '상품명 미정리'));
  const status = group.needsAttention ? (preview ? '상품명 확인이 필요합니다. 상세 목록의 사유를 확인하세요.' : '출고 정보 확인이 필요합니다.') : group.unprepared ? '상품명 정리가 필요합니다.'
    : complete ? '몰 송장 등록 확인 완료' : invoiceState(group.invoiceState) === 'pending' ? '송장 등록 확인 필요' : '';
  if (status) name.append(element('span', status, 'item-status'));
  const quantity = element('div', undefined, 'bundle-number');
  quantity.append(element('strong', count(group.count)), element('span', preview ? '개' : '묶음'));
  const arrow = element('span', undefined, 'expand-arrow'); arrow.setAttribute('aria-hidden', 'true');
  summary.append(name, quantity, arrow); details.append(summary);
  const container = element('div', undefined, 'shipment-details'), table = element('table', undefined, 'shipment-table');
  table.setAttribute('aria-label', `${group.name || '미정리 항목'} 상세 출고 목록`);
  const header = table.createTHead().insertRow();
  for (const label of preview ? ['수취인', '전화번호', '동네', '수량'] : ['수취인', '전화번호', '동네']) {
    const th = element('th', label); th.scope = 'col'; header.append(th);
  }
  const body = table.createTBody();
  for (const shipment of group.shipments) {
    const row = body.insertRow();
    for (const value of [shipment.recipient || '미등록', shipment.phone || '미등록', shipment.neighborhood || '지역 정보 없음']) row.insertCell().textContent = value;
    if (preview) {
      row.insertCell().textContent = count(shipment.quantity);
      if (shipment.note) row.cells[0].append(element('small', shipment.note, 'review-reason'));
    }
  }
  container.append(table); details.append(container); return details;
}
function renderBoard(data) {
  const sameScope = boardData?.date === data.date && boardData?.selectedBatchId === data.selectedBatchId;
  const open = sameScope ? new Set([...$('shipment-groups').querySelectorAll('details[open]')].map(node => node.dataset.key)) : new Set();
  boardData = data; selectedBatchId = data.selectedBatchId;
  $('quantity-label').textContent = '출고 묶음'; $('attention-label').textContent = '미정리 묶음';
  $('board-footnote').textContent = '수량은 원본 주문 행 기준이며 실제 합포장 확정 상자 수는 아닙니다. 한 행에 여러 제품이 포함될 수 있습니다.';
  const [year, month, day] = data.date.split('-');
  $('board-date').textContent = `${year}.${month}.${day} · ${selectedBatchId === null ? '모든 작업' : '선택한 작업'}`;
  $('board-title').textContent = `${Number(month)}월 ${Number(day)}일 출고 목록`;
  for (const [id, key] of [['bundle-count', 'bundleCount'], ['group-count', 'groupCount'], ['unprepared-count', 'unpreparedCount']]) $(id).textContent = count(data.summary[key]);
  const state = invoiceState(data.invoiceState);
  $('invoice-status').textContent = state === 'complete' ? '몰 송장 등록 확인 완료' : state === 'pending' ? '송장 등록 확인 필요' : '송장 정보 연결 전';
  $('invoice-description').textContent = state === 'unavailable' ? '송장 처리 화면에서 파일을 연결하고 등록 상태를 확인하세요.' : '몰 등록이 모두 확인된 항목은 회색입니다. 실물 상차 여부와는 별개입니다.';
  const notices = document.createDocumentFragment();
  if (data.summary.duplicateCount) notices.append(element('li', `같은 출고번호로 다시 올린 ${count(data.summary.duplicateCount)}행은 중복 집계에서 제외했습니다.`));
  for (const issue of data.issues || []) notices.append(element('li', issue.message));
  $('notice-list').replaceChildren(notices); $('board-notices').hidden = !data.summary.duplicateCount && !(data.issues || []).length;
  const groups = document.createDocumentFragment();
  for (const group of data.groups) groups.append(renderGroup(group, open.has(group.key)));
  $('shipment-groups').replaceChildren(groups);
  $('board-empty').hidden = Boolean(data.groups.length);
  $('empty-title').textContent = data.batches.length ? '표시할 출고 묶음이 없습니다.' : '이 날짜에 저장된 작업이 없습니다.';
  $('empty-description').textContent = data.batches.length ? '선택한 작업의 남아 있는 주문을 확인하세요.' : '달력에서 작업이 있는 날짜를 선택하세요.';
  $('updated-at').textContent = `${new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false })} 조회`;
  renderJobs(data);
}
function renderPreview(data) {
  const open = new Set([...$('shipment-groups').querySelectorAll('details[open]')].map(node => node.dataset.key));
  $('board-date').textContent = '네이버 스마트스토어 · 조회 전용';
  $('board-title').textContent = '신규 주문현황';
  $('quantity-label').textContent = '잔여 주문 수량'; $('attention-label').textContent = '확인 필요 수량';
  $('bundle-count').textContent = data ? count(data.summary.quantity) : '—';
  $('group-count').textContent = data ? count(data.summary.groupCount) : '—';
  $('unprepared-count').textContent = data ? count(data.summary.attentionQuantity) : '—';
  $('invoice-status').textContent = '발주 미확인 · 포장 준비용';
  $('invoice-description').textContent = '조회해도 발주확인이나 주문 상태 변경은 하지 않습니다.';
  $('preview-range').textContent = data
    ? `조회 기간: ${formatTime(data.from)} ~ ${formatTime(data.to)} (결제 시각 · 한국 시간) · 주문 ${count(data.summary.orderCount)}건 / 상품주문 ${count(data.summary.rowCount)}행`
    : '조회 범위: 결제 시각 기준 최근 7일. 갱신 버튼을 눌러 현재 발주 미확인 주문을 조회하세요.';
  $('updated-at').textContent = data ? `마지막 성공: ${formatTime(data.updatedAt)}` : '아직 조회하지 않음';
  $('board-notices').hidden = true;
  const groups = document.createDocumentFragment();
  for (const group of data?.groups || []) groups.append(renderGroup(group, open.has(group.key), true));
  $('shipment-groups').replaceChildren(groups);
  $('board-empty').hidden = Boolean(data?.groups.length);
  $('empty-title').textContent = data ? '조회 기간에 발주 미확인 주문이 없습니다.' : '포장을 준비할 신규 주문을 확인하세요.';
  $('empty-description').textContent = data ? '새 주문은 갱신 버튼을 눌러 확인할 수 있습니다.' : '갱신하면 상품명 정리까지 진행합니다. 주문 상태는 바뀌지 않습니다.';
  $('board-footnote').textContent = '부분 취소를 반영한 상품주문별 잔여 수량입니다. 합포장 상자 수가 아니며, 발주확인은 주문 수집 담당자가 별도로 처리합니다. 조회 결과는 저장하지 않아 화면을 다시 열면 재조회가 필요합니다.';
}
function selectMode(next) {
  if (busy || mode === next) return;
  mode = next;
  document.body.classList.toggle('is-new', mode === 'new');
  $('confirmed-mode').setAttribute('aria-pressed', String(mode === 'confirmed'));
  $('new-mode').setAttribute('aria-pressed', String(mode === 'new'));
  $('preview-range').hidden = mode !== 'new';
  const previous = messages[mode];
  message(previous.text, previous.error);
  if (mode === 'new') renderPreview(previewData);
  else if (boardData) renderBoard(boardData);
  else {
    $('shipment-groups').replaceChildren(); $('board-notices').hidden = true;
    $('board-date').textContent = selectedDate; $('board-title').textContent = '출고 목록';
    $('quantity-label').textContent = '출고 묶음'; $('attention-label').textContent = '미정리 묶음';
    for (const id of ['bundle-count', 'group-count', 'unprepared-count']) $(id).textContent = '—';
    $('invoice-status').textContent = '송장 정보 연결 전';
    $('invoice-description').textContent = '현재 색상은 송장 완료 여부를 나타내지 않습니다.';
    $('updated-at').textContent = '조회 중'; $('board-empty').hidden = true;
    $('board-footnote').textContent = '수량은 원본 주문 행 기준이며 실제 합포장 확정 상자 수는 아닙니다. 한 행에 여러 제품이 포함될 수 있습니다.';
    loadBoard({ reloadCalendar: true });
  }
  setBusy(busy);
}
async function refreshPreview() {
  if (busy) return;
  setBusy(true); message('조회·상품명 정리 중…');
  try {
    const data = await api('/api/shipping/preview', { method: 'POST' });
    renderPreview(data); previewData = data; message('');
  } catch (error) {
    message(`${error.name === 'TimeoutError' ? '조회·상품명 정리가 지연되고 있습니다.' : error.message}${previewData ? ' 갱신하지 못해 마지막 성공 결과를 표시하고 있습니다.' : ' 조회를 완료하지 못했습니다. 다시 갱신해 주세요.'}`, true);
  } finally { setBusy(false); }
}
async function loadBoard({ reloadCalendar = false } = {}) {
  if (busy) return;
  setBusy(true); message('');
  try {
    const query = new URLSearchParams({ date: selectedDate });
    if (selectedBatchId !== null) query.set('batchId', selectedBatchId);
    const [data, dates] = await Promise.all([api(`/api/shipping/board?${query}`),
      reloadCalendar ? api(`/api/shipping/dates?month=${calendarMonth}`) : Promise.resolve(null)]);
    if (dates) calendarData = dates;
    renderBoard(data); renderCalendar();
  } catch (error) {
    if (boardData) {
      selectedDate = boardData.date; selectedBatchId = boardData.selectedBatchId; renderCalendar();
    } else $('updated-at').textContent = '조회하지 못함';
    message(`${error.name === 'TimeoutError' ? '서버 응답이 늦어지고 있습니다.' : error.message}${boardData ? ' 마지막 조회 결과를 표시하고 있습니다.' : ' 서버 연결을 확인하고 새로고침해 주세요.'}`, true);
  } finally { setBusy(false); }
}
function selectDay(date) { selectedDate = date; selectedBatchId = null; renderCalendar(); loadBoard(); }
function selectBatch(id) { if (busy) return; selectedBatchId = id; loadBoard(); }
async function changeMonth(direction) {
  if (busy) return;
  const [year, month] = calendarMonth.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + direction, 1)).toISOString().slice(0, 7);
  if (next.startsWith('0000') || next.length !== 7) return;
  setBusy(true);
  try { const data = await api(`/api/shipping/dates?month=${next}`); calendarMonth = next; calendarData = data; renderCalendar(); message(''); }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
$('previous-month').addEventListener('click', () => changeMonth(-1));
$('next-month').addEventListener('click', () => changeMonth(1));
$('today-button').addEventListener('click', () => {
  if (busy) return;
  selectedDate = workDate(); calendarMonth = selectedDate.slice(0, 7); selectedBatchId = null; loadBoard({ reloadCalendar: true });
});
$('confirmed-mode').addEventListener('click', () => selectMode('confirmed'));
$('new-mode').addEventListener('click', () => selectMode('new'));
$('refresh-button').addEventListener('click', () => mode === 'new' ? refreshPreview() : loadBoard({ reloadCalendar: true }));
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { message('전체 화면을 열지 못했습니다. 브라우저의 F11 키도 사용할 수 있습니다.', true); }
});
document.addEventListener('fullscreenchange', () => { $('fullscreen-button').textContent = document.fullscreenElement ? '전체 화면 종료' : '전체 화면'; });
renderCalendar(); loadBoard({ reloadCalendar: true });
