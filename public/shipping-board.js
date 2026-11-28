'use strict';
const $ = id => document.getElementById(id);
const workDate = (value = Date.now()) => new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const count = value => Number(value || 0).toLocaleString('ko-KR');
let selectedDate = workDate(), calendarMonth = selectedDate.slice(0, 7), selectedBatchId = null, selectedRegisteredAt = null;
let calendarData = { days: [] }, boardData = null, busy = false;
const calendarRequests = new Map();
let calendarRequestVersion = 0;
let mode = 'confirmed', previewData = null;
const messages = { confirmed: { text: '', error: false }, new: { text: '', error: false } };
const formatTime = value => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const invoiceState = state => ['unavailable', 'pending', 'complete'].includes(state) ? state : 'unavailable';
const registeredTotal = entry => entry?.totalBoxCount ?? entry?.boxCount ?? 0;
const allJobsSelected = () => selectedBatchId === null && selectedRegisteredAt === null;
const jobTime = (value, hour12 = false, detail = {}) => new Date(value).toLocaleTimeString('ko-KR', {
  timeZone: 'Asia/Seoul', hour: hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12, ...detail,
});

function dispatchStatusLabels(entry) {
  const labels = [];
  if (entry?.canceledBoxCount) labels.push(`취소 완료 ${count(entry.canceledBoxCount)}상자`);
  if (entry?.heldBoxCount) labels.push(`보류 ${count(entry.heldBoxCount)}상자`);
  return labels;
}

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
  for (const button of document.querySelectorAll('.board-sidebar button, .board-modes button, #refresh-button, .registered-actions button')) button.disabled = value;
  $('shipment-groups').setAttribute('aria-busy', String(value));
  $('registered-groups').setAttribute('aria-busy', String(value));
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
    const jobLabels = [];
    if (record?.batchCount) jobLabels.push(`작업 ${record.batchCount}개`);
    if (record?.registeredCount) jobLabels.push(`등록 상자 ${record.registeredCount}개`);
    const button = element('button', String(day), 'calendar-day');
    button.type = 'button'; button.dataset.date = date; button.disabled = busy;
    button.classList.toggle('is-today', date === workDate());
    button.classList.toggle('has-jobs', jobLabels.length > 0);
    button.dataset.invoiceState = invoiceState(record?.invoiceState);
    button.setAttribute('aria-pressed', String(date === selectedDate));
    button.setAttribute('aria-label', `${year}년 ${month}월 ${day}일, ${jobLabels.join(', ') || '작업 없음'}`);
    button.addEventListener('click', () => { if (!busy) selectDay(date); });
    fragment.append(button);
  }
  $('calendar-days').replaceChildren(fragment);
}
function renderJobs(data) {
  const dispatchJobs = data.dispatchJobs || [];
  const jobs = [
    ...data.batches.map(batch => ({ time: batch.createdAt, title: batch.name,
      details: `${jobTime(batch.createdAt)} · 주문 ${count(batch.rowCount)}행`, batchId: batch.id })),
    ...dispatchJobs.map(job => {
      const sameMinute = dispatchJobs.some(other => other !== job && other.registeredAt.slice(0, 16) === job.registeredAt.slice(0, 16));
      const time = jobTime(job.registeredAt, true, sameMinute ? { second: '2-digit', fractionalSecondDigits: 3 } : {});
      return { time: job.registeredAt, registeredAt: job.registeredAt, title: `${time} 출고 작업`, details: `상자 ${count(job.boxCount)}개` };
    }),
  ].sort((left, right) => right.time.localeCompare(left.time));
  $('job-count').textContent = `${count(jobs.length)}개`;
  const fragment = document.createDocumentFragment();
  if (!jobs.length) fragment.append(element('p', '이 날짜에 저장된 작업이 없습니다.', 'job-empty'));
  else {
    const all = element('button', undefined, 'job-button'); all.type = 'button'; all.dataset.batchId = '';
    all.setAttribute('aria-pressed', String(allJobsSelected()));
    const description = [`작업 ${count(jobs.length)}개`];
    const registeredCount = dispatchJobs.reduce((sum, job) => sum + job.boxCount, 0);
    if (registeredCount) description.push(`등록 상자 ${count(registeredCount)}개`);
    all.append(element('strong', '모든 작업 모아 보기'), element('small', description.join(' · ')));
    all.addEventListener('click', () => selectJob()); fragment.append(all);
    for (const job of jobs) {
      const button = element('button', undefined, 'job-button'); button.type = 'button';
      if (job.batchId) button.dataset.batchId = String(job.batchId);
      else button.dataset.registeredAt = job.registeredAt;
      button.setAttribute('aria-pressed', String(job.batchId === selectedBatchId || job.registeredAt === selectedRegisteredAt));
      button.append(element('strong', job.title), element('small', job.details));
      button.addEventListener('click', () => selectJob(job)); fragment.append(button);
    }
  }
  $('job-list').replaceChildren(fragment);
}
function renderGroup(group, open, view = 'confirmed') {
  const registered = view === 'registered', preview = view === 'new';
  const complete = invoiceState(group.invoiceState) === 'complete' && !group.unprepared && !group.needsAttention;
  const allCanceled = registered && group.canceledBoxCount > 0 && group.canceledBoxCount === registeredTotal(group);
  const details = element('details', undefined, 'shipment-card'); details.dataset.key = group.key;
  details.dataset.invoiceState = invoiceState(group.invoiceState); details.open = open;
  details.classList.toggle('is-complete', complete); details.classList.toggle('is-unprepared', Boolean(group.unprepared));
  details.classList.toggle('is-attention', Boolean(group.needsAttention));
  details.classList.toggle('is-canceled', allCanceled);
  const summary = element('summary'), name = element('div', undefined, 'shipment-name');
  const title = element('h2'), titleText = group.name || '상품명 미정리';
  title.append(allCanceled ? element('s', titleText) : titleText);
  name.append(title);
  if (!registered || (group.components?.length ?? 1) === 1) {
    const barcode = group.skuBarcode ? `바코드 ${group.skuBarcode}` : '바코드 없음';
    name.append(element('small', barcode + (group.shipmentType === 'exchange' ? ' · 맞교환' : ''), 'sku-barcode'));
  }
  const status = group.needsAttention ? (view === 'confirmed' ? '출고 정보 확인이 필요합니다.' : '상품명 확인이 필요합니다. 상세 목록의 사유를 확인하세요.') : group.unprepared ? '상품명 정리가 필요합니다.'
    : complete ? '몰 송장 등록 확인 완료' : invoiceState(group.invoiceState) === 'pending' ? '송장 등록 확인 필요' : '';
  if (status) name.append(element('span', status, 'item-status'));
  const dispatchLabels = registered ? dispatchStatusLabels(group) : [];
  if (dispatchLabels.length) name.append(element('span', dispatchLabels.join(' · '), 'item-status'));
  const quantity = element('div', undefined, 'bundle-number');
  quantity.append(element('strong', count(registered ? group.boxCount : group.count)),
    element('span', registered ? '상자' : preview ? '개' : '묶음'));
  const arrow = element('span', undefined, 'expand-arrow'); arrow.setAttribute('aria-hidden', 'true');
  summary.append(name, quantity, arrow); details.append(summary);
  const container = element('div', undefined, 'shipment-details'), table = element('table', undefined, 'shipment-table');
  table.setAttribute('aria-label', `${group.name || '미정리 항목'} 상세 출고 목록`);
  const header = table.createTHead().insertRow();
  const headings = ['수취인', '전화번호', '동네', '판매채널'];
  if (preview) headings.push('수량');
  for (const label of headings) {
    const th = element('th', label); th.scope = 'col'; header.append(th);
  }
  const body = table.createTBody();
  for (const shipment of group.shipments) {
    const row = body.insertRow();
    const canceled = registered && shipment.dispatchState === 'canceled', hold = registered && shipment.dispatchState === 'hold';
    const data = [shipment.recipient || '미등록', shipment.phone || '미등록', shipment.neighborhood || '지역 정보 없음',
      shipment.channels?.join(' · ') || '—'];
    for (const value of data) row.insertCell().append(canceled ? element('s', value) : value);
    if (canceled || hold) {
      row.classList.add(canceled ? 'is-canceled' : 'is-hold');
      row.cells[0].append(element('small', canceled ? shipment.dispatchReason || '취소 완료' : '보류', 'dispatch-status'));
      if (hold && shipment.dispatchReason) row.cells[0].append(element('small', shipment.dispatchReason, 'dispatch-reason'));
    }
    if (preview) {
      row.insertCell().textContent = count(shipment.quantity);
      if (shipment.note) row.cells[0].append(element('small', shipment.note, 'review-reason'));
    }
  }
  container.append(table); details.append(container); return details;
}
function renderBoard(data) {
  const sameScope = boardData?.date === data.date && boardData?.selectedBatchId === data.selectedBatchId
    && boardData?.selectedRegisteredAt === data.selectedRegisteredAt;
  const open = sameScope ? new Set([...$('shipment-groups').querySelectorAll('details[open]')].map(node => node.dataset.key)) : new Set();
  const openRegistered = sameScope ? new Set([...$('registered-groups').querySelectorAll('details[open]')].map(node => node.dataset.key)) : new Set();
  const registered = data.registered, totalRegistered = registeredTotal(registered);
  const registeredGroups = registered?.groups || [];
  boardData = data; selectedBatchId = data.selectedBatchId; selectedRegisteredAt = data.selectedRegisteredAt ?? null;
  $('quantity-label').textContent = '출고 묶음'; $('attention-label').textContent = '미정리 묶음';
  $('board-footnote').textContent = data.groups.length ? '기존 엑셀의 출고 묶음은 원본 주문 행 단위입니다.' : '';
  const [year, month, day] = data.date.split('-');
  $('board-date').textContent = `${year}.${month}.${day} · ${allJobsSelected() ? '모든 작업' : '선택한 작업'}`;
  $('board-title').textContent = `${Number(month)}월 ${Number(day)}일 출고 목록`;
  $('bundle-count').textContent = count(data.summary.bundleCount);
  $('group-count').textContent = count(data.summary.groupCount);
  $('unprepared-count').textContent = count(data.summary.unpreparedCount);
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
  $('registered-section').hidden = !totalRegistered;
  $('logen-export-button').hidden = !allJobsSelected() || !registered?.boxCount;
  $('check-cancellations-button').hidden = !allJobsSelected() || !registered?.naverBoxCount;
  const dispatchLabels = dispatchStatusLabels(registered);
  $('registered-count').textContent = dispatchLabels.length
    ? [`전체 ${count(totalRegistered)}상자`, `출고 대상 ${count(registered.boxCount)}상자`, ...dispatchLabels].join(' · ')
    : `상자 ${count(totalRegistered)}개`;
  const checkedAt = registered?.lastCancellationCheckedAt;
  $('cancellation-checked-at').hidden = !checkedAt;
  $('cancellation-checked-at').textContent = checkedAt ? `최근 취소 확인 ${formatTime(checkedAt)}` : '';
  $('registered-groups').replaceChildren(...registeredGroups.map(group => renderGroup(group, openRegistered.has(group.key), 'registered')));
  $('board-empty').hidden = Boolean(data.groups.length || totalRegistered);
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
  $('registered-section').hidden = true;
  const groups = document.createDocumentFragment();
  for (const group of data?.groups || []) groups.append(renderGroup(group, open.has(group.key), 'new'));
  $('shipment-groups').replaceChildren(groups);
  $('board-empty').hidden = Boolean(data?.groups.length);
  $('empty-title').textContent = data ? '조회 기간에 발주 미확인 주문이 없습니다.' : '포장을 준비할 신규 주문을 확인하세요.';
  $('empty-description').textContent = data ? '새 주문은 갱신 버튼을 눌러 확인할 수 있습니다.' : '갱신하면 상품명 정리까지 진행합니다. 주문 상태는 바뀌지 않습니다.';
  $('board-footnote').textContent = '부분 취소를 반영한 상품주문별 잔여 수량입니다. 합포장 상자 수가 아니며, 발주확인은 주문 수집 담당자가 별도로 처리합니다. 조회 결과는 저장하지 않아 화면을 다시 열면 재조회가 필요합니다.';
}
function selectMode(next) {
  if (busy || mode === next) return;
  mode = next;
  document.body.classList.toggle('is-new', mode !== 'confirmed');
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
async function downloadLogenWorkbook() {
  if (busy || mode !== 'confirmed' || !allJobsSelected() || boardData?.date !== selectedDate || !boardData?.registered?.boxCount) return;
  const date = boardData.date, button = $('logen-export-button'), label = button.textContent;
  setBusy(true); message('');
  button.textContent = '엑셀 준비 중…';
  try {
    const query = new URLSearchParams({ date });
    const response = await fetch(`/api/shipping/logen-export?${query}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || '로젠 업로드 엑셀을 만들지 못했습니다.');
    }
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const filename = encoded ? decodeURIComponent(encoded[1]) : `로젠_업로드_${date}.xlsx`;
    const link = element('a'), url = URL.createObjectURL(await response.blob());
    link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    message(error.name === 'TimeoutError' ? '엑셀을 준비하는 데 시간이 걸립니다. 다시 시도해 주세요.' : error.message, true);
  } finally { button.textContent = label; setBusy(false); }
}
async function checkNaverCancellations() {
  if (busy || mode !== 'confirmed' || !allJobsSelected() || boardData?.date !== selectedDate || !boardData?.registered?.naverBoxCount) return;
  const button = $('check-cancellations-button'), label = button.textContent;
  setBusy(true); message('');
  button.textContent = '취소 상태 확인 중…';
  try {
    const { board, check } = await api('/api/shipping/cancellations/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: boardData.date }),
    });
    renderBoard(board);
    message(check?.unverifiedCount ? `네이버 취소 상태를 갱신했습니다. 조회 미확인 ${count(check.unverifiedCount)}상자가 있습니다.`
      : '네이버 취소 상태를 갱신했습니다.');
  } catch (error) {
    message(error.name === 'TimeoutError' ? '취소 상태 확인이 지연되고 있습니다. 잠시 뒤 다시 조회해 주세요.' : error.message, true);
  } finally { button.textContent = label; setBusy(false); }
}
async function loadBoard({ reloadCalendar = false } = {}) {
  if (busy) return;
  setBusy(true); message('');
  try {
    const query = new URLSearchParams({ date: selectedDate });
    if (selectedBatchId !== null) query.set('batchId', selectedBatchId);
    if (selectedRegisteredAt !== null) query.set('registeredAt', selectedRegisteredAt);
    const request = api(`/api/shipping/board?${query}`);
    const data = await request;
    renderBoard(data); renderCalendar();
    if (reloadCalendar) void loadCalendar(calendarMonth);
  } catch (error) {
    if (boardData) {
      selectedDate = boardData.date; selectedBatchId = boardData.selectedBatchId;
      selectedRegisteredAt = boardData.selectedRegisteredAt ?? null; renderCalendar();
    } else $('updated-at').textContent = '조회하지 못함';
    message(`${error.name === 'TimeoutError' ? '서버 응답이 늦어지고 있습니다.' : error.message}${boardData ? ' 마지막 조회 결과를 표시하고 있습니다.' : ' 서버 연결을 확인하고 새로고침해 주세요.'}`, true);
  } finally { setBusy(false); }
}
function selectDay(date) { selectedDate = date; selectedBatchId = null; selectedRegisteredAt = null; renderCalendar(); loadBoard(); }
function selectJob({ batchId = null, registeredAt = null } = {}) {
  if (busy) return;
  selectedBatchId = batchId; selectedRegisteredAt = registeredAt; loadBoard();
}
async function loadCalendar(month) {
  const version = ++calendarRequestVersion;
  const request = calendarRequests.get(month) || api(`/api/shipping/dates?month=${month}`);
  calendarRequests.set(month, request);
  try {
    const data = await request;
    if (version !== calendarRequestVersion || month !== calendarMonth) return;
    calendarData = data; renderCalendar();
    if (messages.confirmed.text.startsWith('달력 갱신 실패')) {
      messages.confirmed = { text: '', error: false };
      if (mode === 'confirmed') message('');
    }
  } catch {
    if (version !== calendarRequestVersion || month !== calendarMonth) return;
    const text = '달력 갱신 실패. 새로고침해 주세요.';
    messages.confirmed = { text, error: true };
    if (mode === 'confirmed') message(text, true);
  } finally {
    if (calendarRequests.get(month) === request) calendarRequests.delete(month);
  }
}
async function changeMonth(direction) {
  if (busy) return;
  const [year, month] = calendarMonth.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + direction, 1)).toISOString().slice(0, 7);
  if (next.startsWith('0000') || next.length !== 7) return;
  calendarMonth = next; calendarData = { days: [] }; renderCalendar();
  await loadCalendar(next);
}
$('previous-month').addEventListener('click', () => changeMonth(-1));
$('next-month').addEventListener('click', () => changeMonth(1));
$('today-button').addEventListener('click', () => {
  if (busy) return;
  selectedDate = workDate(); calendarMonth = selectedDate.slice(0, 7); selectedBatchId = null; selectedRegisteredAt = null;
  loadBoard({ reloadCalendar: true });
});
$('confirmed-mode').addEventListener('click', () => selectMode('confirmed'));
$('new-mode').addEventListener('click', () => selectMode('new'));
$('logen-export-button').addEventListener('click', downloadLogenWorkbook);
$('check-cancellations-button').addEventListener('click', checkNaverCancellations);
$('refresh-button').addEventListener('click', () => {
  if (mode === 'new') return refreshPreview();
  return loadBoard({ reloadCalendar: true });
});
$('fullscreen-button').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { message('전체 화면을 열지 못했습니다. 브라우저의 F11 키도 사용할 수 있습니다.', true); }
});
document.addEventListener('fullscreenchange', () => { $('fullscreen-button').textContent = document.fullscreenElement ? '전체 화면 종료' : '전체 화면'; });
const requestedDate = new URLSearchParams(window.location.search).get('date');
const requestedTime = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '') && !requestedDate.startsWith('0000') ? Date.parse(requestedDate + 'T00:00:00Z') : NaN;
if (Number.isFinite(requestedTime) && new Date(requestedTime).toISOString().slice(0, 10) === requestedDate) {
  selectedDate = requestedDate;
  calendarMonth = selectedDate.slice(0, 7);
}
renderCalendar();
loadBoard({ reloadCalendar: true });
