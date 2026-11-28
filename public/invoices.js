'use strict';
const $ = id => document.getElementById(id);
const count = value => Number(value || 0).toLocaleString('ko-KR');
const formatTime = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const workDate = (value = Date.now()) => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
let current = null, runs = [], busy = false, checkingRegistration = false;
let dayBatches = [], previewOrders = [], previewReady = false, selectedSourceDate = workDate();
let showRecentHistory = false;
let dateCheckAvailable = false;
const selectedBatches = new Map();
const itemChanges = new Map(), issueChanges = new Map(), trackingChanges = new Map();
const registrationLabels = { unchecked: '등록 미조회', pending: '등록 미확인', complete: '등록 확인 완료', conflict: '송장 불일치' };
const historyRegistrationLabels = { unchecked: '네이버 등록 미조회', pending: '네이버 미등록', partial: '네이버 일부 등록', complete: '네이버 등록 확인 완료', conflict: '네이버 송장 확인 필요' };
const outsideLabels = { external_registered: '네이버 등록 확인 완료', pending: '발송대기 · 파일 누락 가능성', canceled: '취소 확인', returned: '반품 확인', attention: '일부 등록·상태 확인 필요', unknown: '등록 여부 미확인', naver_not_applicable: '네이버 조회 대상 아님', exchange: '맞교환 · 별도 출고' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, error = false) {
  $('message').textContent = text; $('message').hidden = !text; $('message').classList.toggle('error', error);
}
function isDirty() { return itemChanges.size > 0 || issueChanges.size > 0 || trackingChanges.size > 0; }
function draftItem(item) { return { ...item, ...itemChanges.get(String(item.id)) }; }
function draftIssue(issue) { return { ...issue, ...issueChanges.get(issue.key) }; }
function readOnlyOrder(order) { return Boolean(order.latestStatus?.readonly || ['canceled', 'returned'].includes(order.state)); }
function scopeUnavailable() { return current && (current.scopeRequired || !Array.isArray(current.orders)); }
function downloadItems() { return (current?.items || []).filter(item => item.decision === 'include' && item.registrationState !== 'complete' && !item.sourceRegistered); }
function blockingKeys(item) { return item.blockingIssueKeys || (item.issues || []).filter(key => current.issues.some(issue => issue.key === key && issue.blocking)); }
function refreshControls() {
  const dirty = isDirty(), unresolved = (current?.issues || []).filter(issue => issue.reviewRequired !== false && !issue.resolved).length;
  const pendingTracking = current?.trackingReview?.pendingCount || 0;
  const exportable = downloadItems().length;
  const blocked = (current?.items || []).some(item => item.decision === 'include' && (item.registrationState === 'conflict' || blockingKeys(item).length));
  const needsReview = pendingTracking > 0 || unresolved > 0 || blocked || scopeUnavailable() || current?.rematchRequired;
  for (const control of document.querySelectorAll('button, input, select, textarea')) control.disabled = busy || control.dataset.locked === 'true';
  $('import-button').disabled = busy || !previewReady || !$('naver-files').files.length || !$('courier-files').files.length || !$('carrier').value;
  $('save-button').disabled = busy || !dirty || scopeUnavailable() || current?.rematchRequired;
  $('export-button').disabled = busy || !current || dirty || needsReview || !exportable;
  $('check-button').disabled = busy || !current || dirty || (!current.items.length && !current.outsideOrders?.length) || scopeUnavailable() || current.rematchRequired;
  $('check-button').textContent = checkingRegistration ? '조회 중…' : '등록 상태 확인';
  $('date-check-button').hidden = Boolean(current);
  $('date-check-button').disabled = busy || dirty || !dateCheckAvailable;
  $('date-check-button').textContent = checkingRegistration ? '조회 중…' : '등록 상태 확인';
  $('refresh-run').disabled = busy || !current;
  $('tracking-review-controls').hidden = !current?.trackingReview?.groups.length || scopeUnavailable();
  $('tracking-review-count').textContent = pendingTracking ? `송장 선택 남음 ${count(pendingTracking)}건` : '송장 선택 완료';
  if (trackingChanges.size) $('tracking-review-count').textContent += ` · ${count(trackingChanges.size)}건 저장 전`;
  const replacements = replacementChoices();
  $('replace-tracking-button').hidden = !replacements.length;
  $('replace-tracking-button').disabled = busy || dirty || !replacements.length;
  $('pending-export-button').hidden = $('full-export-button').hidden = !current || scopeUnavailable() || current.rematchRequired || !current.items.length;
  $('pending-export-button').disabled = $('full-export-button').disabled = busy || dirty;
  for (const button of document.querySelectorAll('.manual-tracking-button')) button.disabled = busy || dirty;
  $('dirty-note').textContent = dirty ? '검토 내용이 변경되었습니다. 저장해 주세요.' : '';
  if (current) {
    const generated = Boolean(current.run.generatedAt || current.run.fileCreatedAt);
    $('run-state').textContent = dirty ? `${generated ? '파일 생성됨' : '작성 중'} · 검토 내용 저장 전` : generated ? '파일 생성됨' : '작성 중 · 저장됨';
    $('run-state').classList.toggle('is-generated', generated); $('run-state').classList.toggle('is-dirty', dirty);
  }
  $('save-button').textContent = busy && dirty ? '저장 중…' : '검토 내용 저장';
  if (current) $('export-note').textContent = dirty ? '변경한 검토 내용을 먼저 저장하세요.'
    : scopeUnavailable() || current.rematchRequired ? '등록용 엑셀을 만들려면 파일을 다시 매칭하세요.'
    : pendingTracking ? `송장 선택 ${count(pendingTracking)}건이 남았습니다.`
    : unresolved ? '경고를 확인하고 검토 내용을 저장하세요.'
    : blocked ? '송장 충돌 항목을 확인하세요.'
    : exportable ? `등록용 엑셀 대상 ${count(exportable)}건` : '새로 등록할 주문이 없습니다.';
}
function setBusy(value) { busy = value; $('run-section').setAttribute('aria-busy', String(value)); refreshControls(); }
async function api(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(options.method ? 300000 : 30000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '송장 업무를 처리하지 못했습니다. 다시 시도해 주세요.');
  return data;
}
function allowDiscard() { return !isDirty() || window.confirm('저장하지 않은 검토 내용이 있습니다. 변경 내용을 버리고 이동할까요?'); }
function clearMatch() {
  current = null; itemChanges.clear(); issueChanges.clear(); trackingChanges.clear(); $('run-section').hidden = true; $('preview-section').hidden = false;
  $('saved-files').hidden = true; $('import-form').hidden = false; $('import-form').reset();
  $('naver-file-list').textContent = '선택한 파일이 없습니다. 여러 파일을 함께 올릴 수 있습니다.';
  $('courier-file-list').textContent = '송장번호가 들어 있는 택배사 출력파일을 선택하세요.';
  renderHistory(); message('');
}
function sourceLocation(source) {
  if (!source) return '';
  const batch = selectedBatches.get(source.batchId) || current?.batches?.find(batch => batch.id === source.batchId), date = source.batchCreatedAt || batch?.createdAt;
  if (source.dispatchBoxId) return `출고 등록 ${formatTime(date)}`;
  return [date ? `작업 ${formatTime(date)}` : '', source.sourceFile ? `파일: ${source.sourceFile}` : '',
    [source.sourceSheet ? `시트: ${source.sourceSheet}` : '', source.sourceRow !== undefined ? `${source.sourceRow}행` : ''].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
}
function orderGroups(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = order.sourceType === 'naver_only' ? 'naver_only'
      : order.sourceType === 'registered_dispatch' ? `dispatch-${order.source.batchCreatedAt}` : order.batchId;
    if (!groups.has(key)) groups.set(key, { batchId: order.batchId, sourceType: order.sourceType, orders: [] });
    groups.get(key).orders.push(order);
  }
  return [...groups.values()];
}
function groupHeading(group, columns) {
  const row = element('tr', undefined, 'order-group-header'), cell = element('th'), heading = element('div', undefined, 'order-group-title');
  cell.colSpan = columns; cell.scope = 'rowgroup';
  const source = group.orders[0].source, batch = selectedBatches.get(group.batchId) || current?.batches?.find(batch => batch.id === group.batchId);
  const sourceTime = source?.batchCreatedAt || batch?.createdAt, date = sourceTime ? workDate(sourceTime) : '';
  const otherDate = date && date !== selectedSourceDate;
  row.classList.toggle('other-date', Boolean(otherDate));
  const files = [...new Set(group.orders.map(order => order.source?.sourceFile).filter(Boolean))];
  const title = group.sourceType === 'naver_only' ? '① 네이버 주문파일'
    : group.sourceType === 'registered_dispatch' ? `출고 등록 ${formatTime(sourceTime)}` : `작업 ${formatTime(sourceTime)}`;
  heading.append(element('strong', title));
  if (date) heading.append(element('span', otherDate ? date < selectedSourceDate ? '이전 날짜 주문' : '다른 날짜 주문' : '선택한 날짜', 'order-date-badge'));
  if (group.sourceType !== 'registered_dispatch') heading.append(element('span', `파일: ${files.join(' · ') || batch?.name || '원본 정보 없음'}`));
  heading.append(element('small', `${count(group.orders.length)}행`));
  cell.append(heading); row.append(cell); return row;
}
function renderPreview() {
  const fragment = document.createDocumentFragment();
  for (const group of orderGroups(previewOrders)) {
    fragment.append(groupHeading(group, 4));
    for (const order of group.orders) {
    const row = element('tr', undefined, matchClass(order.state)), recipient = element('td'), product = element('td'), location = element('td'), state = element('td');
    recipient.append(element('strong', order.recipient || '수취인 정보 없음')); if (order.phone) recipient.append(element('small', order.phone));
    product.append(element('strong', order.cleanedName || order.originalName || '상품명 미정리'));
    location.append(element('small', sourceLocation(order.source), 'source-location'));
    state.append(element('span', matchLabel(order.state), `match-state ${matchClass(order.state)}`));
    for (const number of order.trackingNumbers || []) state.append(element('small', number));
    if (order.state !== 'not_matched' && order.reason && order.reason !== matchLabel(order.state) && order.state !== 'pending') state.append(element('small', order.reason, 'match-reason'));
    if (order.checkedAt) state.append(element('small', `조회 ${formatTime(order.checkedAt)}`));
    const latestRunId = order.latestStatus?.runId || order.latestRunId, processingDate = order.latestStatus?.processingDate || order.processingDate;
    if (latestRunId && (order.itemIds?.length || order.evidence || order.latestStatus)) {
      const link = element('button', `${processingDate || ''} 처리 내역`, 'text-button'); link.type = 'button';
      link.addEventListener('click', () => { if (!busy && allowDiscard()) loadRun(latestRunId); }); state.append(link);
    }
    row.append(recipient, product, location, state); fragment.append(row);
    }
  }
  $('preview-rows').replaceChildren(fragment); $('preview-count').textContent = `${count(previewOrders.length)}행`;
}
async function loadPreview() {
  previewReady = false; dateCheckAvailable = false;
  if (!selectedBatches.size) { previewOrders = []; previewReady = true; renderPreview(); $('preview-message').textContent = '이 날짜에 등록한 주문이 없어도 파일을 올리면 다른 날짜의 주문을 찾아 매칭합니다.'; return; }
  $('preview-message').textContent = '해당 날짜의 확인한 주문 전체를 불러오고 있습니다.';
  try {
    const query = new URLSearchParams({ batchIds: JSON.stringify([...selectedBatches.keys()]) });
    const data = await api(`/api/invoices/orders?${query}`);
    if (!Array.isArray(data.orders)) throw new Error('현재 실행 중인 서버가 이전 버전입니다. system0 서버를 재시작해 주세요.');
    previewOrders = data.currentOrders || data.orders; dateCheckAvailable = data.checkAvailable ?? Boolean(dayBatches.length);
    previewReady = true; renderPreview(); $('preview-message').textContent = '선택한 날짜의 원본 주문과 최근 연결 결과입니다. 파일 매칭은 날짜와 관계없이 ① 네이버 주문에 해당하는 자료를 찾습니다.';
  } catch (error) { previewOrders = []; renderPreview(); $('preview-message').textContent = error.message; }
}
async function resumeSavedMatch() {
  try {
    const data = await api(`/api/invoices/latest?date=${encodeURIComponent(selectedSourceDate)}`);
    if (!Object.hasOwn(data, 'invoice')) throw new Error('저장된 매칭을 읽을 수 없습니다.');
    if (data.invoice) {
      showRun(data.invoice); message('저장된 파일과 송장 매칭·검토 내용을 불러왔습니다.');
    }
  } catch { $('source-message').textContent += ' · 저장된 매칭을 확인하지 못했습니다. 서버를 재시작한 뒤 날짜를 다시 선택해 주세요.'; }
}
async function loadSourceDate({ discardConfirmed = false, restoreSaved = true } = {}) {
  if (!discardConfirmed && !allowDiscard()) { $('source-date').value = selectedSourceDate; return; }
  clearMatch(); selectedSourceDate = $('source-date').value; showRecentHistory = false; setBusy(true);
  try {
    const data = await api(`/api/batches?date=${encodeURIComponent(selectedSourceDate)}`); dayBatches = data.batches || [];
    selectedBatches.clear(); for (const batch of dayBatches) selectedBatches.set(batch.id, batch);
    $('source-message').textContent = dayBatches.length ? `${selectedSourceDate} · 전체 작업 ${count(dayBatches.length)}개${dayBatches.some(batch => batch.running) ? ' · 상품명 정리 중인 작업이 있어 매칭은 완료 후 가능합니다.' : ''}` : '이 날짜에 확인한 주문 작업이 없습니다.';
    await loadPreview();
    if (restoreSaved) await resumeSavedMatch();
  } catch (error) { dayBatches = []; selectedBatches.clear(); previewOrders = []; renderPreview(); $('source-message').textContent = error.message; previewReady = false; }
  finally {
    try { await loadHistory(); } catch (error) { $('history-message').textContent = error.message; }
    setBusy(false);
  }
}
function fileList(inputId, listId, emptyText) {
  const files = [...$(inputId).files];
  $(listId).textContent = files.length ? files.map(file => file.name).join('\n') : emptyText;
  refreshControls();
}
function renderHistory() {
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    const button = element('button', undefined, 'run-button'); button.type = 'button'; button.disabled = busy;
    button.setAttribute('aria-pressed', String(current?.run.id === run.id));
    button.append(element('strong', `파일 생성 ${formatTime(run.fileCreatedAt || run.generatedAt)}`), element('small', run.carrierName || '네이버'));
    for (const file of run.files || []) button.append(element('small', `파일: ${file.name}`));
    const state = run.registrationState || 'unchecked';
    button.append(element('span', historyRegistrationLabels[state] || '네이버 등록 확인 필요', `registration-badge ${state === 'complete' ? 'registered' : state}`));
    if (run.registrationSummary?.total) button.append(element('small', `등록 확인 ${count(run.registrationSummary.complete)} / ${count(run.registrationSummary.total)}건`));
    button.addEventListener('click', () => { if (!busy && current?.run.id !== run.id && allowDiscard()) loadRun(run.id); });
    fragment.append(button);
  }
  $('run-list').replaceChildren(fragment);
  $('history-message').textContent = runs.length ? `${showRecentHistory ? '최근' : selectedSourceDate} 생성 파일 ${count(runs.length)}개 내역` : `${showRecentHistory ? '최근' : selectedSourceDate} 송장 파일 생성 내역이 없습니다.`;
}
async function loadHistory() {
  const query = showRecentHistory ? '' : `?date=${encodeURIComponent(selectedSourceDate)}`;
  const data = await api(`/api/invoices${query}`); runs = (data.runs || []).filter(run => run.fileCreatedAt || run.generatedAt); renderHistory();
}
function saveItemDraft(item, fields) {
  const key = String(item.id), next = { ...draftItem(item), ...fields };
  const selectedTrackingNumber = next.selectedTrackingNumber === item.trackingSelection?.trackingNumber ? undefined : next.selectedTrackingNumber;
  if (next.decision === item.decision && (next.note || '') === (item.note || '') && !selectedTrackingNumber) itemChanges.delete(key);
  else itemChanges.set(key, { id: item.id, decision: next.decision, note: next.note || '', ...(selectedTrackingNumber ? { selectedTrackingNumber } : {}) });
  for (const control of document.querySelectorAll('[data-item-id]')) if (control.dataset.itemId === key && control !== document.activeElement) control.value = control.classList.contains('item-decision') ? next.decision : next.note || '';
  refreshControls();
}
function warningReview(issues, showLocation = false, manualAvailable = false) {
    const issue = issues[0], keys = issues.map(value => value.key);
    const missingOrder = issue.kind === 'missing_saved_order', issueMessage = missingOrder ? '주문 누락 가능성있음' : issue.message;
    const draft = draftIssue(issue), row = element('div', undefined, 'record-warning');
    row.classList.toggle('is-resolved', Boolean(draft.resolved));
    const description = element('div'); description.append(element('strong', issueMessage));
    const location = [];
    if (issue.productOrderId) location.push(`상품주문번호 ${issue.productOrderId}`);
    if (issue.internalId) location.push(`내부 출고번호 ${issue.internalId}`);
    if (issue.source) location.push([issue.source.sourceFile, issue.source.sourceSheet,
      issue.source.sourceRow !== undefined ? `${issue.source.sourceRow}행` : ''].filter(Boolean).join(' · '));
    if (showLocation && location.length) description.append(element('small', location.filter(Boolean).join('\n')));
    if (['registration_recheck', 'tracking_review_required'].includes(issue.kind)) {
      description.append(element('small', issue.kind === 'tracking_review_required' ? '적용 송장과 교체·분할 상자를 선택하세요.'
        : '하단의 등록 상태 확인을 눌러 현재 상태를 다시 조회하세요.'));
      row.append(description); return row;
    }
    const manualWarning = manualAvailable && ['parcel_uncertain', 'split_mapping', 'reprint_uncertain'].includes(issue.kind);
    if (!missingOrder) description.append(element('small', issue.blocking
      ? manualWarning ? '실제 송장 확인에서 사용한 송장을 확정하세요.' : `${issue.resolved ? '확인 내용이 저장되었습니다. ' : ''}관련 상품주문은 보류·제외해야 합니다.`
      : issue.resolved ? '확인 내용이 저장되었습니다.'
      : '경고 내용을 확인해 주세요.'));
    const review = element('div', undefined, 'issue-review'), label = element('label'), checkbox = element('input');
    row.dataset.issueKeys = JSON.stringify(keys);
    checkbox.type = 'checkbox'; checkbox.checked = Boolean(draft.resolved); checkbox.dataset.locked = String(Boolean(issue.resolved)); checkbox.disabled = busy || Boolean(issue.resolved);
    checkbox.className = 'issue-confirm';
    label.append(checkbox, document.createTextNode('경고 내용을 확인했습니다'));
    const note = element('input'); note.type = 'text'; note.value = draft.note || ''; note.maxLength = 1000;
    note.className = 'issue-note';
    note.placeholder = '메모 (선택)'; note.setAttribute('aria-label', `${issueMessage} 메모 (선택)`); note.disabled = busy;
    const update = () => {
      for (const original of issues) {
        const value = { key: original.key, resolved: checkbox.checked, note: note.value };
        if (value.resolved === Boolean(original.resolved) && value.note === (original.note || '')) issueChanges.delete(original.key);
        else issueChanges.set(original.key, value);
      }
      for (const warning of document.querySelectorAll('.record-warning[data-issue-keys]')) {
        const originals = JSON.parse(warning.dataset.issueKeys).map(key => current.issues.find(value => value.key === key));
        if (!originals.some(value => keys.includes(value.key))) continue;
        const values = originals.map(draftIssue), confirmed = values.every(value => value.resolved);
        const input = warning.querySelector('.issue-confirm'), memo = warning.querySelector('.issue-note');
        input.checked = confirmed; input.indeterminate = !confirmed && values.some(value => value.resolved);
        if (memo !== document.activeElement) memo.value = values.every(value => value.note === values[0].note) ? values[0].note || '' : '';
        warning.classList.toggle('is-resolved', confirmed);
      }
      refreshControls();
    };
    checkbox.addEventListener('change', update); note.addEventListener('input', update);
    review.append(label, note); row.append(description, review); return row;
}
function appendWarnings(target, issues, manualAvailable = false) {
  const groups = new Map();
  for (const issue of issues) {
    const draft = draftIssue(issue), key = JSON.stringify([issue.message, Boolean(issue.blocking), Boolean(draft.resolved), draft.note || '']);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }
  for (const group of groups.values()) target.append(warningReview(group, false, manualAvailable));
}
function warningsForOrder(order) {
  const linked = current.items.filter(item => order.itemIds.includes(item.id));
  return (current.issues || []).filter(issue => (order.issues || []).includes(issue.key)).map(issue => ({ ...issue,
    blocking: issue.blocking && (!linked.length || linked.some(item => blockingKeys(item).includes(issue.key))) }));
}
function warningsForCourier(courier) {
  const source = courier.source || courier;
  return (current.issues || []).filter(issue => issue.key === courier.issueKey
    || (courier.internalId && issue.internalId === courier.internalId)
    || (issue.source?.sourceRow != null && issue.source.sourceRow === source.sourceRow
      && issue.source.sourceSheet === source.sourceSheet && issue.source.sourceFile === source.sourceFile
      && (!issue.source.fileHash || issue.source.fileHash === source.fileHash)));
}
function renderIssues() {
  const assigned = new Set((current.orders || []).flatMap(order => order.issues || []));
  for (const courier of current.unmatchedCouriers || []) for (const issue of warningsForCourier(courier)) assigned.add(issue.key);
  const issues = scopeUnavailable() ? [] : (current.issues || []).filter(issue => issue.reviewRequired !== false && !assigned.has(issue.key));
  const fragment = document.createDocumentFragment();
  $('issues-section').hidden = !issues.length;
  $('issues-count').textContent = `${count(issues.length)}건`;
  for (const issue of issues) fragment.append(warningReview([issue], true));
  $('issues-list').replaceChildren(fragment);
}
function sourceDescription(item) {
  const lines = [];
  if (item.orderId) lines.push(`네이버 주문번호: ${item.orderId}`);
  if (item.internalId) lines.push(`내부 출고번호: ${item.internalId}`);
  for (const source of item.sourceRows || []) lines.push(sourceLocation(source));
  return lines.join('\n');
}
function matchClass(state) {
  if (state === 'invalid_id') return 'number-problem';
  if (state === 'external_registered') return 'external-registered';
  if (['pending', 'unknown', 'attention'].includes(state)) return 'needs-review';
  if (['missing_courier', 'missing_naver', 'outside_scope', 'missing_saved_order', 'source_deleted'].includes(state)) return 'missing-source';
  if (['hold', 'unsupported_mall', 'conflict'].includes(state)) return 'needs-review';
  return '';
}
function matchLabel(state) {
  if (outsideLabels[state]) return outsideLabels[state];
  return { ready: '송장 찾음', complete: '등록 확인 완료', hold: '충돌·판단 필요', excluded: '제외',
    invalid_id: '연결 번호 확인 필요', missing_courier: '대응 송장 없음', missing_naver: '네이버 자료 없음', outside_scope: '선택한 작업에 없음',
    missing_saved_order: '확인한 주문 자료 없음', unsupported_mall: '미지원 몰 확인 필요', source_deleted: '원본 자료 없음', not_matched: '송장 매칭 전', not_targeted: '최근 네이버 파일의 대상 아님', conflict: '충돌·판단 필요' }[state] || '확인 필요';
}
function appendRegistrationComparison(target, appliedTrackingNumber, remote, perProduct = false) {
  if (!remote) return;
  if (!perProduct) {
    if (!remote.fresh || remote.trackingNumber !== appliedTrackingNumber) {
      target.append(element('small', `네이버: ${remote.trackingNumber || '미등록'}`));
    }
    if (!remote.fresh) target.append(element('small', `이전 조회${remote.checkedAt ? ' ' + formatTime(remote.checkedAt) : ''}`));
    return;
  }
  target.append(element('small', `system0: ${appliedTrackingNumber || '미선택'}`), element('small', `네이버: ${remote.trackingNumber || '미등록'}`));
  if (remote.fresh && typeof remote.matches === 'boolean') target.append(element('small', remote.matches ? '송장 일치'
    : remote.trackingNumber && remote.trackingNumber === appliedTrackingNumber ? '택배사 다름' : '송장 다름'));
  if (!remote.fresh || remote.checkedAt) target.append(element('small', `${remote.fresh ? '조회' : '이전 조회'}${remote.checkedAt ? ' ' + formatTime(remote.checkedAt) : ''}`));
}
function reviewControls(original) {
  const item = draftItem(original), group = element('div', undefined, 'item-review');
  const decision = element('select', undefined, 'item-decision'); decision.dataset.itemId = String(item.id); decision.setAttribute('aria-label', `${item.productOrderId} 처리 방법`);
  for (const [value, text] of [['include', '송장 찾음'], ['hold', '확인·보류'], ['exclude', '이번 처리에서 제외']]) {
    const option = new Option(text, value);
    option.disabled = value === 'include' && (item.issues || []).some(key => current.issues.some(issue => issue.key === key && issue.kind === 'registration_recheck'));
    decision.add(option);
  }
  decision.value = item.decision; decision.disabled = busy;
  const note = element('input', undefined, 'item-note'); note.type = 'text'; note.dataset.itemId = String(item.id); note.value = item.note || ''; note.placeholder = '검토 사유 (선택)'; note.maxLength = 1000; note.setAttribute('aria-label', `${item.productOrderId} 검토 사유`); note.disabled = busy;
  decision.addEventListener('change', () => saveItemDraft(original, { decision: decision.value }));
  note.addEventListener('input', () => saveItemDraft(original, { note: note.value }));
  group.append(decision, note); return group;
}
function shipmentHistory(items, courierRows = []) {
  const shipments = new Map();
  for (const item of items) for (const shipment of item.physicalShipments || []) if (!shipments.has(shipment.trackingNumber)) shipments.set(shipment.trackingNumber, shipment);
  if (!shipments.size && !courierRows.length) return null;
  const history = element('details'), shown = new Set();
  history.append(element('summary', shipments.size ? '송장 이력' : '송장 원본'));
  for (const shipment of shipments.values()) {
    const lines = [`${shipment.trackingNumber} · ${shipment.valid === true ? '유효' : shipment.valid === false ? '이전 송장' : '유효 여부 확인 필요'}`];
    if (shipment.round) lines.push(`차수 ${shipment.round}`);
    if (shipment.originalTrackingNumber) lines.push(`원송장 ${shipment.originalTrackingNumber}`);
    if (shipment.issueCount !== null && shipment.issueCount !== undefined) lines.push(`발행횟수 ${shipment.issueCount}`);
    if (shipment.printedAt) lines.push(`출력 ${shipment.printedAt}`);
    if (shipment.replacedBy) lines.push(`교체 송장 ${shipment.replacedBy}`);
    for (const source of shipment.sources || []) {
      const location = sourceLocation(source);
      shown.add(JSON.stringify([shipment.trackingNumber, location]));
      lines.push(location);
    }
    history.append(element('p', lines.join('\n')));
  }
  for (const source of courierRows) {
    const location = sourceLocation(source);
    if (!shown.has(JSON.stringify([source.trackingNumber, location]))) {
      history.append(element('p', [source.trackingNumber, location].filter(Boolean).join('\n')));
    }
  }
  return history;
}
function saveTrackingDraft(group, fields) {
  const next = { trackingNumber: group.selectedTrackingNumber || '', mode: group.mode || '', ...trackingChanges.get(group.key), ...fields };
  const candidate = group.candidates.find(candidate => candidate.trackingNumber === next.trackingNumber);
  if (group.kind === 'reprint_reference') {
    next.mode = candidate?.selectable && group.replaceEligible ? 'replace' : '';
    if (!candidate?.referenceOnly || !next.acknowledgeOriginal) delete next.acknowledgeOriginal;
  } else if (next.mode === 'replace' && !candidate?.currentFile
    || next.mode === 'split' && group.splitEligible === false
    || next.mode === 'assign' && (group.kind !== 'assignment' || group.assignEligible === false)) next.mode = '';
  if (next.trackingNumber === (group.selectedTrackingNumber || '') && next.mode === (group.mode || '')) trackingChanges.delete(group.key);
  else trackingChanges.set(group.key, { key: group.key, ...next });
  renderItems(); refreshControls();
}
function replacementChoices() {
  return (current?.trackingReview?.groups || []).filter(group => group.needsSelection && group.replacementEligible && group.replacementTrackingNumber)
    .map(group => ({ key: group.key, trackingNumber: group.replacementTrackingNumber, mode: 'replace' }));
}
function trackingChoices(order, linked) {
  const container = element('div');
  const groups = (current?.trackingReview?.groups || []).filter(group => group.itemIds.some(id => linked.some(item => item.id === id))
    && !(group.needsSelection && !group.assignEligible && !group.replaceEligible && !group.splitEligible
      && current.manualTracking?.groups?.some(manual => group.productOrderIds.includes(manual.productOrderId))));
  if (!groups.length) {
    for (const number of order.trackingNumbers) container.append(element('strong', number));
    return container;
  }
  for (const group of groups) {
    const assignment = group.kind === 'assignment';
    const reference = group.kind === 'reprint_reference';
    const selected = group.selectedTrackingNumber || linked.find(item => group.itemIds.includes(item.id))?.trackingNumber || order.trackingNumbers[0] || '';
    const eligible = candidate => reference ? group.replaceEligible && candidate.selectable
      : candidate.valid === true && candidate.selectable !== false && (assignment ? group.assignEligible
        : group.splitEligible || group.replaceEligible && candidate.currentFile);
    let editor = container;
    if (!group.needsSelection) {
      container.append(element('strong', selected));
      if (group.mode === 'split' || assignment) container.append(element('small', assignment ? '분리 배송' : '분할 대표'));
      if (!group.candidates.some(candidate => candidate.trackingNumber !== selected && eligible(candidate))) continue;
      editor = element('details', undefined, 'tracking-edit');
      editor.open = trackingChanges.has(group.key);
      editor.append(element('summary', '송장 수정'));
      container.append(editor);
    }
    const draft = { trackingNumber: group.selectedTrackingNumber || '', mode: group.mode || '', ...trackingChanges.get(group.key) };
    const registered = new Set(linked.filter(item => group.itemIds.includes(item.id) && item.naverRegistration?.fresh
      && item.naverRegistration.carrierCode === current.run.carrierCode).map(item => item.naverRegistration.trackingNumber));
    const controls = element('div', undefined, 'tracking-review-choice'), numberLabel = element('label', '적용 송장'), number = element('select');
    number.setAttribute('aria-label', `${order.recipient || group.internalId} 적용 송장`);
    number.add(new Option('송장 선택', ''));
    for (const candidate of group.candidates) {
      const role = candidate.role === 'original' ? candidate.referenceOnly ? '원송장 (번호만 있음)' : '원송장'
        : candidate.role === 'reprint' ? '재출력 송장' : '';
      const label = [role, candidate.trackingNumber, candidate.round ? `${candidate.round}차` : '', candidate.printedAt
        ? /^\d{2}:\d{2}:\d{2}$/.test(candidate.printedAt) ? candidate.printedAt : formatTime(candidate.printedAt) : '',
        registered.size === 1 && registered.has(candidate.trackingNumber) ? '네이버 등록' : ''].filter(Boolean).join(' · ');
      const option = new Option(label, candidate.trackingNumber);
      option.disabled = reference ? !candidate.selectable : candidate.valid === false || candidate.selectable === false;
      number.add(option);
    }
    number.value = draft.trackingNumber;
    number.disabled = assignment && group.assignEligible === false || reference && !group.replaceEligible;
    if (number.disabled) number.dataset.locked = 'true';
    number.addEventListener('change', () => saveTrackingDraft(group, { trackingNumber: number.value,
      ...(assignment ? { mode: number.value ? 'assign' : '' } : {}), ...(reference ? { acknowledgeOriginal: false } : {}) }));
    numberLabel.append(number); controls.append(numberLabel);
    if (reference) {
      if (group.candidates.some(candidate => candidate.trackingNumber === draft.trackingNumber && candidate.referenceOnly)) {
        const label = element('label', undefined, 'tracking-reference-check');
        const check = element('input'); check.type = 'checkbox'; check.checked = Boolean(draft.acknowledgeOriginal);
        check.addEventListener('change', () => saveTrackingDraft(group, { acknowledgeOriginal: check.checked }));
        label.append(check, element('span', '상자에 붙인 원송장을 확인했습니다.')); controls.append(label);
      }
      if (group.reason && group.needsSelection) controls.append(element('small', group.reason, 'match-reason'));
      editor.append(controls);
      continue;
    }
    if (assignment) {
      controls.append(element('small', '분리 배송'));
      if (group.reason && group.needsSelection) controls.append(element('small', group.reason, 'match-reason'));
      editor.append(controls);
      continue;
    }
    const modeLabel = element('label', '송장 처리'), mode = element('select');
    mode.setAttribute('aria-label', `${order.recipient || group.internalId} 송장 처리`);
    mode.add(new Option('교체·분할 선택', ''));
    const replace = new Option('교체 · 선택한 송장만 사용', 'replace');
    replace.disabled = group.replaceEligible === false || !group.candidates.some(candidate => candidate.trackingNumber === draft.trackingNumber && candidate.currentFile);
    const split = new Option('분할 상자 · 대표 송장 선택', 'split'); split.disabled = group.splitEligible === false;
    mode.add(replace); mode.add(split);
    mode.value = draft.mode;
    mode.addEventListener('change', () => saveTrackingDraft(group, { mode: mode.value }));
    modeLabel.append(mode); controls.append(modeLabel);
    if (group.reason && group.needsSelection) controls.append(element('small', group.reason, 'match-reason'));
    editor.append(controls);
  }
  return container;
}
function displayedOrders() {
  const orders = scopeUnavailable() ? previewOrders : current?.currentOrders || current?.orders || previewOrders;
  return [...orders.filter(order => order.sourceType === 'naver_only'), ...orders.filter(order => order.sourceType !== 'naver_only')];
}
function renderItems() {
  const query = $('search').value.trim().toLocaleLowerCase(), filter = $('item-filter').value;
  const allOrders = displayedOrders();
  const orders = allOrders.filter(order => {
    const linked = current.items.filter(item => order.itemIds.includes(item.id)).map(draftItem);
    const readonly = readOnlyOrder(order);
    const matches = filter === 'all' || (filter === 'attention' ? Boolean(matchClass(order.state)) || (!readonly && linked.some(item => item.decision === 'hold'))
      : filter === 'registered' ? ['complete', 'external_registered'].includes(order.state) : filter === 'include' ? order.trackingNumbers.length > 0
      : readonly ? order.state === ({hold:'hold',exclude:'excluded'}[filter] || filter) : linked.some(item => item.decision === filter));
    return matches && (!query || [order.recipient, order.phone, order.cleanedName, order.originalName, order.optionName, order.orderId, order.internalId, ...order.trackingNumbers, ...linked.map(item => item.productOrderId)].join(' ').toLocaleLowerCase().includes(query));
  });
  const fragment = document.createDocumentFragment();
  for (const group of orderGroups(orders)) {
    fragment.append(groupHeading(group, 5));
    for (const order of group.orders) {
    const linked = current.items.filter(item => order.itemIds.includes(item.id)), readonly = readOnlyOrder(order), row = element('tr', undefined, matchClass(order.state));
    row.classList.toggle('is-excluded', order.state === 'excluded');
    row.classList.toggle('combined-order', linked.length > 1);
    const recipient = element('td'); recipient.append(element('strong', order.recipient || '수취인 정보 없음')); if (order.phone) recipient.append(element('small', order.phone));
    for (const item of linked) recipient.append(element('small', item.productOrderId));
    const product = element('td'); product.append(element('strong', order.cleanedName || order.originalName || '상품명 미정리'));
    if (['naver_only', 'saved_product'].includes(order.sourceType) && order.optionName && order.optionName !== order.cleanedName) product.append(element('small', `선택 옵션: ${order.optionName}`));
    const location = sourceLocation(order.source);
    const sources = [...new Set(linked.map(sourceDescription))].filter(Boolean);
    if (location && !sources.some(source => source.includes(location))) sources.push(location);
    const details = element('details');
    details.append(element('summary', '주문 원본'), element('p', sources.join('\n') || (order.internalId ? `내부 출고번호: ${order.internalId}` : order.reason || '연결된 자료가 없습니다.')));
    product.append(details);
    if (readonly && order.originalOrder) {
      const original = order.originalOrder, history = element('details'); history.append(element('summary', '당시 매칭 이력'));
      const warnings = current.issues.filter(issue => (original.issues || []).includes(issue.key));
      history.append(element('p', [matchLabel(original.state), original.reason, ...(original.trackingNumbers || []), ...warnings.map(issue => issue.message)].filter(Boolean).join('\n')));
      product.append(history);
    }
    const tracking = element('td');
    const manual = (current.manualTracking?.groups || []).find(group => linked.some(item => item.productOrderId === group.productOrderId));
    if (readonly) for (const number of order.trackingNumbers) tracking.append(element('strong', number));
    else tracking.append(trackingChoices(order, linked));
    if (!order.trackingNumbers.length) tracking.append(element('span', manual ? '적용 송장 미확정' : order.state === 'not_matched' ? '송장 매칭 전' : '대응 송장 없음'));
    if (!readonly && manual) {
      const button = element('button', '실제 송장 확인', 'manual-tracking-button'); button.type = 'button';
      button.setAttribute('aria-label', `${manual.recipient || order.recipient} 실제 송장 확인`);
      button.addEventListener('click', () => openManualTracking(manual)); tracking.append(button);
    }
    const history = shipmentHistory(linked, order.courierRows); if (history) tracking.append(history);
    const review = element('td');
    if (readonly) {
      const latest = order.latestStatus || {};
      if (latest.runId) {
        const link = element('button', `${latest.processingDate || ''} 처리 내역`, 'text-button'); link.type = 'button';
        link.addEventListener('click', () => { if (!busy && allowDiscard()) loadRun(latest.runId); }); review.append(link);
      }
      if (order.reason && !['ready', 'complete', 'external_registered'].includes(order.state)) review.append(element('small', order.reason, 'match-reason'));
    } else {
      const registrationConcern = linked.some(item => item.registrationState === 'conflict' || item.registrationRecheck && !item.statusFresh);
      const warnings = warningsForOrder(order).filter(issue => issue.kind !== 'registration_recheck' || !registrationConcern);
      const active = warnings.filter(issue => !issue.resolved || issue.blocking);
      const recorded = warnings.filter(issue => issue.resolved && !issue.blocking);
      const showReason = !['ready', 'complete'].includes(order.state) && (!registrationConcern || active.length);
      if (showReason) review.append(element('span', matchLabel(order.state), `match-state ${matchClass(order.state)}`));
      if (showReason && !warnings.length && order.reason) review.append(element('small', order.reason, 'match-reason'));
      if (linked.length || recorded.length) {
        const reviewDetails = element('details');
        reviewDetails.open = linked.some(item => itemChanges.has(String(item.id))) || recorded.some(issue => issueChanges.has(issue.key));
        reviewDetails.append(element('summary', '검토 내역'));
        for (const item of linked) {
          if (linked.length > 1) reviewDetails.append(element('small', `상품주문번호 ${item.productOrderId}`));
          reviewDetails.append(reviewControls(item));
        }
        appendWarnings(reviewDetails, recorded);
        review.append(reviewDetails);
      }
      appendWarnings(review, active, Boolean(manual));
    }
    const registration = element('td');
    if (readonly) {
      const state = order.latestStatus?.registrationState || 'unchecked', complete = ['complete','external_registered'].includes(order.state);
      const label = ['canceled','returned'].includes(order.state) ? matchLabel(order.state) : complete ? '등록 확인 완료' : registrationLabels[state] || matchLabel(order.state);
      registration.append(element('span', label, `registration-badge ${complete ? 'registered' : state}`));
      const products = (order.latestStatus?.products || []).filter(product => product.naverRegistration);
      if (!products.length && order.latestStatus?.checkedAt) registration.append(element('small', `조회 ${formatTime(order.latestStatus.checkedAt)}`));
      for (const product of products) {
        if (products.length > 1) registration.append(element('small', product.productOrderId));
        appendRegistrationComparison(registration, product.appliedTrackingNumber, product.naverRegistration, products.length > 1);
      }
    } else {
      for (const item of linked) {
        const state = item.registrationState || 'unchecked', remote = item.naverRegistration;
        const carrierMismatch = remote?.fresh && remote.matches === false && remote.trackingNumber === item.trackingNumber;
        const label = state === 'conflict' && carrierMismatch ? '택배사 불일치'
          : state === 'unchecked' && item.registrationRecheck ? '등록 재확인 필요' : registrationLabels[state] || '확인 필요';
        if (linked.length > 1) registration.append(element('small', item.productOrderId));
        registration.append(element('span', label, `registration-badge ${state === 'complete' ? 'registered' : state}`));
        appendRegistrationComparison(registration, item.trackingNumber, remote, linked.length > 1);
        const onlyTrackingConflict = item.registrationProblems?.length === 1 && item.registrationProblems[0] === 'tracking_conflict';
        if (state === 'conflict' && item.registrationNote && !onlyTrackingConflict) registration.append(element('small', item.registrationNote));
        if (item.sourceRegistered && state !== 'complete') registration.append(element('small', '원본에 동일 송장 있음 · 중복 다운로드 제외'));
      }
      if (!linked.length) registration.append(element('small', order.state === 'not_matched' ? '매칭 전' : '등록 대상 미연결'));
    }
    row.append(recipient, product, tracking, review, registration); fragment.append(row);
    }
  }
  $('item-rows').replaceChildren(fragment); $('items-empty').hidden = Boolean(orders.length);
  $('visible-count').textContent = `표시 ${count(orders.length)} / ${count(allOrders.length)}행 · 원본 작업별 표시 · 합배송은 한 행에 여러 상품주문 표시`;
  renderOutsideTarget();
  renderUnmatched();
}
function renderOutsideTarget() {
  const relatedRows = new Set((current.orders || []).flatMap(order => [order.rowId,
    ...(order.sourceType === 'saved_product' ? current.items.filter(item => order.itemIds.includes(item.id))
      .flatMap(item => (item.sourceRows || []).map(source => source.rowId)) : [])]));
  const orders = [...(current.currentOutsideOrders || current.outsideOrders || [])], represented = new Set([...relatedRows, ...orders.map(order => order.rowId)]);
  for (const order of previewOrders) if (!represented.has(order.rowId)) orders.push(order);
  const fragment = document.createDocumentFragment(), states = {};
  for (const order of orders) states[order.state] = (states[order.state] || 0) + 1;
  $('outside-target-section').hidden = scopeUnavailable() || !orders.length;
  $('outside-target-count').textContent = `${count(orders.length)}행`;
  const unverified = orders.length - ['external_registered', 'pending', 'canceled', 'returned', 'attention', 'naver_not_applicable', 'exchange'].reduce((sum, state) => sum + (states[state] || 0), 0);
  $('outside-target-summary').textContent = [states.external_registered && `네이버 등록 확인 ${count(states.external_registered)}`,
    states.pending && `발송대기 ${count(states.pending)}`, states.canceled && `취소 ${count(states.canceled)}`,
    states.returned && `반품 ${count(states.returned)}`, states.attention && `상태 확인 필요 ${count(states.attention)}`,
    states.naver_not_applicable && `네이버 조회 대상 아님 ${count(states.naver_not_applicable)}`,
    states.exchange && `맞교환 ${count(states.exchange)}`,
    unverified && `미확인 ${count(unverified)}`].filter(Boolean).join(' · ');
  $('outside-target-summary').classList.toggle('needs-attention', Boolean(states.pending || states.attention || unverified));
  for (const group of orderGroups(orders)) {
    fragment.append(groupHeading(group, 4));
    for (const order of group.orders) {
    const row = element('tr', undefined, matchClass(order.state)), recipient = element('td'), product = element('td'), status = element('td');
    recipient.append(element('strong', order.recipient || '수취인 정보 없음'));
    if (order.orderId) recipient.append(element('small', order.orderId));
    product.append(element('strong', order.cleanedName || order.originalName || '상품명 미정리'));
    status.append(element('span', outsideLabels[order.state] || '등록 여부 미확인', `match-state ${matchClass(order.state)}`));
    for (const number of order.trackingNumbers || []) status.append(element('small', number));
    if (order.reason && order.reason !== outsideLabels[order.state] && order.state !== 'pending') status.append(element('small', order.reason));
    if (order.checkedAt) status.append(element('small', `조회 ${formatTime(order.checkedAt)}`));
    row.append(recipient, product, element('td', sourceLocation(order.source), 'source-location'), status);
    fragment.append(row);
    }
  }
  $('outside-target-rows').replaceChildren(fragment);
}
function renderUnmatched() {
  const unmatched = scopeUnavailable() ? [] : current.unmatchedCouriers || [], fragment = document.createDocumentFragment();
  for (const courier of unmatched) {
    const row = element('tr', undefined, matchClass(courier.state)), location = element('td'), recipient = element('td');
    location.append(element('small', sourceLocation(courier.source || courier), 'source-location'));
    recipient.append(element('strong', courier.recipient || '수취인 정보 없음')); if (courier.phone) recipient.append(element('small', courier.phone));
    const internal = element('td', courier.internalId || '번호 없음'), tracking = element('td', courier.trackingNumber || '번호 없음'), status = element('td');
    const warnings = warningsForCourier(courier);
    status.append(element('span', matchLabel(courier.state), `match-state ${matchClass(courier.state)}`));
    for (const text of new Set(warnings.length ? warnings.map(issue => issue.message) : [courier.reason])) {
      if (text) status.append(element('small', text, 'match-reason'));
    }
    row.append(location, recipient, internal, tracking, status); fragment.append(row);
  }
  $('unmatched-rows').replaceChildren(fragment); $('unmatched-section').hidden = !unmatched.length; $('unmatched-count').textContent = `원본 ${count(unmatched.length)}행`;
}
function showRun(data) {
  data.rematchRequired ??= !data.run.matchingVersion;
  current = data; itemChanges.clear(); issueChanges.clear(); trackingChanges.clear(); $('upload-section').hidden = false; $('preview-section').hidden = true; $('run-section').hidden = false;
  renderPreview();
  const dates = [...new Set([...(data.batches || []).map(batch => workDate(batch.createdAt)), ...data.items.map(item => item.sourceDate).filter(Boolean)])].sort();
  $('source-message').textContent = `처리 날짜 ${data.run.sourceDate || selectedSourceDate} · ${dates.length ? `원본 날짜 ${dates.join(' · ')}` : '연결된 저장 원본 없음'} · ① 네이버 파일 기준으로 매칭합니다.`;
  const unavailable = scopeUnavailable();
  $('saved-files').hidden = unavailable; $('import-form').hidden = !unavailable && !data.rematchRequired;
  $('saved-file-list').textContent = (data.files || []).map(file => `${file.kind === 'naver' ? '① 네이버' : '③ 택배사'}: ${file.name}`).join('\n');
  $('scope-note').hidden = !unavailable && !data.rematchRequired; $('scope-note').textContent = data.scopeRequired
    ? '이전 결과는 매칭 범위가 없어 사용할 수 없습니다. 왼쪽 날짜를 선택한 뒤 파일을 다시 매칭해 주세요.'
    : unavailable ? '현재 실행 중인 system0 서버가 이전 버전입니다. 서버를 재시작한 뒤 새 송장 처리를 시작해 주세요.'
    : '이전 방식으로 매칭한 내역입니다. 다른 날짜의 주문까지 찾으려면 같은 ①·③ 파일을 다시 선택해 매칭하세요. 기존 검토·파일 생성 내역은 보존됩니다.';
  $('run-title').textContent = '송장 매칭 결과';
  const fileSummary = (data.files || []).map(file => `${file.kind === 'naver' ? '①' : '③'} ${file.name}`).join(' · ');
  $('run-description').textContent = `${formatTime(data.run.createdAt)} · 네이버 스마트스토어 · ${data.run.carrierName || ''}\n${fileSummary || '선택한 확인한 주문 작업 기준으로 연결한 결과입니다.'}${data.run.generatedAt ? `\n파일 생성: ${formatTime(data.run.generatedAt)} · 네이버 등록 상태는 별도로 확인합니다.` : ''}`;
  const currentSummary = data.currentSummary || data.summary;
  $('total-count').textContent = count(data.items.length); $('ready-count').textContent = count(currentSummary.connected ?? data.items.filter(item => item.sourceRows?.length).length);
  const sameDate = data.summary.selectedDate ?? data.items.filter(item => item.sourceDate === selectedSourceDate).length;
  const otherDate = data.summary.otherDate ?? data.items.filter(item => item.sourceDate && item.sourceDate !== selectedSourceDate).length;
  const unknownDate = data.summary.unknownDate ?? data.items.filter(item => !item.sourceDate).length;
  $('match-date-summary').textContent = `선택한 날짜 ${count(sameDate)}건 + 다른 날짜 ${count(otherDate)}건${unknownDate ? ` + 원본 날짜 확인 필요 ${count(unknownDate)}건` : ''} = 이번 처리 대상 ${count(data.items.length)}건`;
  const missing = currentSummary.missingSaved ?? data.items.filter(item => !item.sourceRows?.length).length;
  $('attention-count').textContent = count(missing); $('registered-count').textContent = count(data.currentSummary?.complete ?? data.items.filter(item => item.registrationState === 'complete' && item.statusFresh).length);
  $('naver-missing-note').hidden = !missing;
  $('naver-missing-note').textContent = `① 최종 네이버 주문 중 ${count(missing)}건에 대응하는 ② 확인한 주문 자료가 없습니다. 아래 첫 그룹에서 송장 누락 여부를 확인하세요. 보류·제외된 상품주문은 엑셀에 포함하지 않습니다.`;
  const checkedAt = (data.currentOrders || []).map(order => order.latestStatus?.checkedAt).filter(Boolean).sort().at(-1) || data.run.statusCheckedAt;
  $('last-check').textContent = checkedAt ? `마지막 등록 조회: ${formatTime(checkedAt)}` : '아직 네이버 등록 상태를 조회하지 않았습니다.';
  renderRegistrationResult();
  renderIssues(); if (unavailable) $('issues-section').hidden = true; renderItems(); renderHistory(); refreshControls();
  loadArchivedFiles(data.run);
}
async function loadRun(id) {
  setBusy(true); message('송장 매칭 결과를 불러오고 있습니다.');
  try {
    const data = await api(`/api/invoices/${encodeURIComponent(id)}`);
    const date = data.run.sourceDate || workDate(data.batches?.[0]?.createdAt || data.run.createdAt);
    if (!previewReady || date !== selectedSourceDate) { $('source-date').value = date; await loadSourceDate({ discardConfirmed: true, restoreSaved: false }); setBusy(true); }
    showRun(data); message('');
  }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
async function importFiles(event) {
  event.preventDefault(); if (busy || !$('import-form').reportValidity()) return;
  if (!previewReady) { message('날짜별 주문 조회가 끝난 뒤 매칭해 주세요.', true); return; }
  const form = new FormData($('import-form')); form.set('sourceDate', selectedSourceDate);
  setBusy(true); message('송장을 매칭하고, 이번 네이버 파일에 없는 관련 주문의 등록 상태를 조회하고 있습니다.');
  try { showRun(await api('/api/invoices/import', { method: 'POST', body: form })); $('naver-password').value = ''; message('매칭 결과와 경고를 확인한 뒤 엑셀을 다운로드하세요.'); await loadHistory(); }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
async function saveReview() {
  if (busy || !current || !isDirty()) return;
  const resolutions = [...issueChanges.values()];
  if (resolutions.some(issue => !issue.resolved && issue.note.trim())) { message('메모를 입력한 경고의 확인란도 선택해 주세요.', true); return; }
  const choices = [...trackingChanges.values()];
  if (choices.some(choice => !choice.trackingNumber || !['replace', 'split', 'assign'].includes(choice.mode))) {
    message('적용 송장과 교체·분할 상자 처리 방식을 모두 선택해 주세요.', true); return;
  }
  if (choices.some(choice => !choice.acknowledgeOriginal && current.trackingReview.groups.find(group => group.key === choice.key)
    ?.candidates.some(candidate => candidate.trackingNumber === choice.trackingNumber && candidate.referenceOnly))) {
    message('상자에 붙인 원송장을 확인한 뒤 저장해 주세요.', true); return;
  }
  const body = { changes: [...itemChanges.values()], issueResolutions: resolutions.filter(issue => issue.resolved).map(({ key, note }) => ({ key, note })) };
  let next = current, trackingSaved = false, reviewSaved = false;
  setBusy(true); message('검토 내용을 저장하고 있습니다.');
  try {
    if (choices.length) {
      next = await api(`/api/invoices/${current.run.id}/tracking`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: current.viewVersion, choices }) });
      trackingSaved = true; trackingChanges.clear();
      body.changes = body.changes.map(change => change.decision === current.items.find(item => item.id === change.id)?.decision
        ? { ...change, decision: next.items.find(item => item.id === change.id)?.decision || change.decision } : change);
    }
    body.issueResolutions = body.issueResolutions.filter(issue => next.issues.some(value => value.key === issue.key));
    if (body.changes.length || body.issueResolutions.length) {
      next = await api(`/api/invoices/${next.run.id}/items`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expectedVersion: next.viewVersion }) });
    }
    reviewSaved = true;
    showRun(next); message('검토 내용을 저장했습니다.'); await loadHistory();
  } catch (error) {
    if (trackingSaved && !reviewSaved && (body.changes.length || body.issueResolutions.length)) {
      showRun(next);
      for (const change of body.changes) itemChanges.set(String(change.id), change);
      for (const issue of resolutions) if (next.issues.some(value => value.key === issue.key)) issueChanges.set(issue.key, issue);
      renderItems(); renderIssues(); refreshControls();
    }
    message(reviewSaved ? `검토 내용은 저장되었습니다. ${error.message}` : trackingSaved ? `송장 선택은 저장되었습니다. ${error.message}` : error.message, true);
  }
  finally { setBusy(false); }
}
async function replaceCurrentTracking() {
  if (busy || !current || isDirty()) return;
  const choices = replacementChoices();
  if (!choices.length) return;
  const groups = current.trackingReview.groups.filter(group => choices.some(choice => choice.key === group.key));
  const products = new Set(groups.flatMap(group => group.productOrderIds));
  const targets = groups.map(group => `${group.recipient || group.internalId} → ${group.replacementTrackingNumber}`).join('\n');
  if (!window.confirm(`이번 파일의 송장으로 내부 출고 ${count(groups.length)}건 · 상품주문 ${count(products.size)}건을 교체할까요?\n\n${targets}\n\n이전 송장은 이력으로 남습니다.`)) return;
  setBusy(true); message('이번 파일의 송장으로 교체하고 있습니다.');
  try {
    const next = await api(`/api/invoices/${current.run.id}/tracking`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: current.viewVersion, choices }) });
    showRun(next);
    message(`송장을 교체했습니다.${next.trackingReview.pendingCount ? ` 선택 남음 ${count(next.trackingReview.pendingCount)}건` : ''}`);
    await loadHistory();
  } catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
async function downloadRegistrationExcel() {
  if (busy || !current || isDirty()) return;
  let downloadStarted = false;
  setBusy(true); message('네이버 등록용 엑셀을 만들고 있습니다.');
  try {
    const response = await fetch(`/api/invoices/${current.run.id}/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'export', expectedVersion: current.viewVersion }), cache: 'no-store', signal: AbortSignal.timeout(60000) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || '엑셀을 만들지 못했습니다.'); }
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = element('a');
    const disposition = response.headers.get('content-disposition') || '', match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    link.href = url; link.download = match ? decodeURIComponent(match[1]) : `네이버_송장등록_${workDate(current.run.createdAt)}.xlsx`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    downloadStarted = true; showRun(await api(`/api/invoices/${current.run.id}`)); showRecentHistory = true; await loadHistory();
    message('네이버 등록용 엑셀을 만들었습니다.');
  } catch (error) { message(downloadStarted ? `엑셀 다운로드 요청은 완료했지만 생성 내역을 갱신하지 못했습니다. 왼쪽 새로고침으로 확인해 주세요.\n${error.message}` : error.message, true); }
  finally { setBusy(false); }
}

const manualModes = { separate: '분리 배송', combined: '합포장', replace: '재출력 교체', split: '분할 상자 · 대표 송장' };
function invoiceActionOptions(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function actionSelect(label, placeholder, options) {
  const field = element('label', label), select = element('select');
  select.add(new Option(placeholder, ''));
  for (const [value, name] of options) select.add(new Option(name, value));
  field.append(select); return { field, select };
}
function invoiceActionDialog({ title, fields, path, getBody, preview, applyLabel, applied }) {
  const dialog = $('invoice-action-dialog'), form = $('invoice-action-form'), editor = $('invoice-action-fields'),
    previewArea = $('invoice-action-preview'), error = $('invoice-action-error'), submit = $('invoice-action-submit'), back = $('invoice-action-back');
  const runId = current.run.id, expectedVersion = current.viewVersion;
  let reviewed = null;
  const reset = () => {
    reviewed = null; editor.hidden = false; previewArea.hidden = true; error.hidden = true; back.hidden = true;
    submit.textContent = '미리보기'; delete submit.dataset.locked; refreshControls();
  };
  $('invoice-action-title').textContent = title; editor.replaceChildren(fields); reset();
  back.onclick = reset;
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || submit.disabled) return;
    error.hidden = true; setBusy(true);
    try {
      const body = reviewed || { expectedVersion, ...getBody() };
      const result = await api(`/api/invoices/${runId}/${path}`, invoiceActionOptions({ ...body, validateOnly: !reviewed }));
      if (reviewed) {
        dialog.close(); applied(result); return;
      }
      const { content, canApply } = preview(result);
      reviewed = { ...body, expectedVersion: result.viewVersion };
      previewArea.replaceChildren(content); editor.hidden = true; previewArea.hidden = false; back.hidden = false;
      submit.textContent = applyLabel; submit.dataset.locked = String(!canApply);
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { setBusy(false); }
  };
  dialog.showModal();
}
function productActionLabel(item) {
  const name = [item.productName, item.optionName].filter(Boolean);
  return [...new Set(name)].concat(item.productOrderId).join(' · ');
}
function openManualTracking(group) {
  if (busy || isDirty() || !current) return;
  const groups = current.manualTracking.groups.filter(value => value.productOrderId === group.productOrderId
    || group.orderId && value.orderId === group.orderId);
  const fields = document.createDocumentFragment();
  const entries = groups.map(entry => {
    const item = element('fieldset', undefined, 'invoice-action-item'), companions = element('div', undefined, 'invoice-action-fields');
    item.append(element('legend', productActionLabel(entry)));
    if (entry.trackingNumber) item.append(element('small', `현재 송장 ${entry.trackingNumber}`));
    const candidates = entry.candidates.filter(candidate => candidate.valid !== false);
    const number = actionSelect('적용 송장', '송장 선택', candidates.map(candidate => [candidate.trackingNumber,
      [candidate.trackingNumber, candidate.sources?.[0]?.sourceRow ? `원본 ${candidate.sources[0].sourceRow}행` : '',
        candidate.valid === null ? '사용 여부 확인 필요' : ''].filter(Boolean).join(' · ')]));
    const mode = actionSelect('배송 방식', '방식 선택', (entry.modes || Object.keys(manualModes)).map(value => [value, manualModes[value]]));
    const pair = element('div', undefined, 'invoice-action-fields'); pair.append(number.field, mode.field);
    let related = [];
    const showCompanions = () => {
      const selected = candidates.find(candidate => candidate.trackingNumber === number.select.value);
      related = !selected || !mode.select.value ? [] : candidates.filter(candidate => candidate.internalId === selected.internalId
        && candidate.trackingNumber !== selected.trackingNumber).map(candidate => {
        const options = [['unused', '미사용 확인']];
        if (mode.select.value === 'split') options.unshift(['used', '추가 상자에 사용']);
        return { number: candidate.trackingNumber, ...actionSelect(candidate.trackingNumber, '사용 여부 미확인', options) };
      });
      companions.replaceChildren(...related.map(value => value.field));
    };
    number.select.addEventListener('change', showCompanions); mode.select.addEventListener('change', showCompanions);
    item.append(pair, companions); fields.append(item);
    return {
      read() {
        const trackingNumber = number.select.value, selectedMode = mode.select.value;
        if (!trackingNumber && !selectedMode) return null;
        if (!trackingNumber || !selectedMode) throw new Error(`${entry.productOrderId}의 적용 송장과 배송 방식을 선택해 주세요.`);
        return { productOrderId: entry.productOrderId, trackingNumber, mode: selectedMode,
          usedTrackingNumbers: related.filter(value => value.select.value === 'used').map(value => value.number),
          unusedTrackingNumbers: related.filter(value => value.select.value === 'unused').map(value => value.number) };
      },
    };
  });
  invoiceActionDialog({ title: `${group.recipient || '상품주문'} 실제 송장 확인`, fields, path: 'confirm-tracking',
    getBody() {
      const resolutions = entries.map(entry => entry.read()).filter(Boolean);
      if (!resolutions.length) throw new Error('실제 사용한 송장을 하나 이상 선택해 주세요.');
      return { resolutions };
    },
    preview(result) {
      const content = element('ul');
      for (const confirmed of result.confirmations) {
        const extras = (confirmed.usedTrackingNumbers || []).join(', '), unused = (confirmed.unusedTrackingNumbers || []).join(', ');
        content.append(element('li', `${productActionLabel(confirmed)}\n${confirmed.previousTrackingNumber || '미확정'} → ${confirmed.trackingNumber} · ${manualModes[confirmed.mode]}${extras ? `\n추가 상자 ${extras}` : ''}${unused ? `\n미사용 ${unused}` : ''}`));
      }
      return { content, canApply: result.changed > 0 };
    }, applyLabel: '실제 송장 확정', applied(result) {
      showRun(result); message(`상품주문 ${count(result.changed)}건의 실제 송장을 확정했습니다.`);
    },
  });
}

function additionalFileLink(runId, file, text = file.filename) {
  const link = element('a', text);
  link.href = `/api/invoices/${runId}/additional-files/${file.id}`; link.download = file.filename;
  return link;
}
let archivedFilesRequest = 0;
async function loadArchivedFiles(run, open = false) {
  const request = ++archivedFilesRequest, history = $('invoice-file-history'), list = $('invoice-file-list');
  const runId = run.id;
  list.replaceChildren(); history.hidden = !run.savedFileAvailable;
  if (run.savedFileAvailable) {
    const row = element('li'), link = element('a', `${formatTime(run.generatedAt)} · 기존 보관본`);
    link.href = `/api/invoices/${runId}/download`;
    row.append(link); list.append(row);
  }
  try {
    const { files } = await api(`/api/invoices/${runId}/additional-files`);
    if (request !== archivedFilesRequest || current?.run.id !== runId) return;
    for (const file of files) {
      const row = element('li');
      row.append(additionalFileLink(runId, file, `${formatTime(file.createdAt)} · ${file.mode === 'all' ? '전체 확인용' : '미등록 추가본'} · ${count(file.productOrderIds.length)}건`));
      list.append(row);
    }
    history.hidden = !run.savedFileAvailable && !files.length;
    current.run.fileCreatedAt = files.at(-1)?.createdAt || current.run.generatedAt;
    refreshControls();
    if (open) history.open = true;
  } catch { /* 보관 파일 목록 조회 오류는 송장 작업을 막지 않습니다. */ }
}
function openAdditionalExport(mode) {
  if (busy || isDirty() || !current) return;
  const runId = current.run.id, completeFile = mode === 'all', fields = document.createDocumentFragment();
  const items = current.items.filter(item => !item.superseded), byId = new Map(items.map(item => [item.productOrderId, item]));
  const entries = [];
  if (completeFile) fields.append(element('p', '등록 완료 건도 포함하는 확인용 파일입니다.'));
  else {
    const toolbar = element('div', undefined, 'invoice-export-search'), search = element('input');
    search.type = 'search'; search.placeholder = '수취인·상품주문번호 검색';
    search.setAttribute('aria-label', '엑셀에 넣을 주문 검색'); search.value = $('search').value;
    const selectResults = element('button', '검색 결과만 선택'), selectedCount = element('span');
    selectResults.type = 'button'; selectedCount.setAttribute('role', 'status');
    toolbar.append(search, selectResults, selectedCount); fields.append(toolbar);
    const empty = element('p', '검색 결과가 없습니다.'); fields.append(empty);
    const updateCount = () => { selectedCount.textContent = `${count(entries.filter(entry => entry.checkbox.checked).length)}건 선택`; };
    for (const item of items) {
      const label = element('label', undefined, 'invoice-export-target'), checkbox = element('input'); checkbox.type = 'checkbox';
      const recipient = (current.currentOrders || current.orders).find(order => order.itemIds.includes(item.id))?.recipient || item.recipient;
      const keywords = [recipient, item.productOrderId, item.orderId, item.trackingNumber, item.productName, item.optionName].join(' ').toLocaleLowerCase();
      label.append(checkbox, element('span', [recipient, productActionLabel(item)].filter(Boolean).join(' · ')));
      checkbox.addEventListener('change', updateCount);
      fields.append(label); entries.push({ productOrderId: item.productOrderId, checkbox, label, keywords });
    }
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase();
      for (const entry of entries) entry.label.hidden = !entry.keywords.includes(query);
      const hasResults = entries.some(entry => !entry.label.hidden);
      empty.hidden = hasResults;
      selectResults.hidden = !query || !hasResults;
    };
    search.addEventListener('input', filter);
    selectResults.addEventListener('click', () => {
      for (const entry of entries) entry.checkbox.checked = !entry.label.hidden;
      updateCount();
    });
    filter(); updateCount();
  }
  invoiceActionDialog({ title: completeFile ? '전체 확인용 엑셀' : '선택 주문 미등록 엑셀', fields, path: 'additional-files',
    getBody() {
      const productOrderIds = completeFile ? null : entries.filter(entry => entry.checkbox.checked).map(entry => entry.productOrderId);
      if (!completeFile && !productOrderIds.length) throw new Error('엑셀에 넣을 상품주문을 하나 이상 선택해 주세요.');
      return { mode, productOrderIds };
    },
    preview(result) {
      const content = document.createDocumentFragment(), included = element('ul'), skipped = element('ul');
      for (const item of result.included) included.append(element('li', `${productActionLabel(byId.get(item.productOrderId) || item)} · ${item.trackingNumber}`));
      for (const item of result.skipped) skipped.append(element('li', `${productActionLabel(byId.get(item.productOrderId) || item)}\n${item.reason}`));
      content.append(element('strong', `포함 ${count(result.included.length)}건`), included);
      if (result.skipped.length) content.append(element('strong', `미포함 ${count(result.skipped.length)}건`), skipped);
      return { content, canApply: result.included.length > 0 };
    }, applyLabel: '엑셀 생성 및 다운로드', applied(result) {
      const link = additionalFileLink(runId, result.file);
      document.body.append(link); link.click(); link.remove();
      loadArchivedFiles(current.run, true);
      loadHistory().catch(error => { $('history-message').textContent = error.message; });
      message(`${completeFile ? '전체' : '미등록 추가'} 엑셀 ${count(result.included.length)}건의 다운로드를 요청했습니다.${result.skipped.length ? ` 미포함 ${count(result.skipped.length)}건` : ''}`);
    },
  });
}
function renderRegistrationResult() {
  const result = $('registration-result'); result.classList.remove('is-error');
  if (current?.currentSummary) {
    const summary = current.currentSummary;
    result.textContent = `등록 확인 ${count(summary.complete)} · 송장 찾음 ${count(summary.ready)} · 취소 ${count(summary.canceled)} · 반품 ${count(summary.returned)} · 확인 필요 ${count((summary.unknown || 0) + (summary.attention || 0) + (summary.hold || 0))}`;
    return;
  }
  if (!current?.run.statusCheckedAt) { result.textContent = '이번 처리 대상은 아직 등록 상태를 조회하지 않았습니다.'; return; }
  const items = current.items || [], counts = { complete: 0, pending: 0, conflict: 0, unchecked: 0 };
  for (const item of items) counts[item.statusFresh ? item.registrationState : 'unchecked']++;
  result.textContent = `${formatTime(current.run.statusCheckedAt)} 조회 · 상품주문 ${count(items.length)}건\n등록 완료 ${count(counts.complete)} · 미등록 ${count(counts.pending)} · 충돌 ${count(counts.conflict)}${counts.unchecked ? ` · 재조회 필요 ${count(counts.unchecked)}` : ''}`;
}
async function checkRegistration() {
  if (busy || isDirty() || (!current && !dateCheckAvailable)) return;
  const runId = current?.run.id;
  checkingRegistration = true;
  $('registration-result').classList.remove('is-error'); $('registration-result').textContent = '네이버 등록 상태를 조회하고 있습니다…';
  setBusy(true); message('관련 처리 내역의 등록 상태를 조회하고 있습니다.');
  try {
    const result = await api('/api/invoices/check-date', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({date:selectedSourceDate}) });
    await loadPreview();
    if (runId) showRun(await api(`/api/invoices/${runId}`));
    await loadHistory();
    const failed = result.errors?.length || 0;
    message(failed ? `일부 등록 상태를 확인하지 못했습니다.\n${[...new Set(result.errors.map(value => value.error))].join('\n')}`
      : `관련 처리 내역 ${count(result.runIds?.length)}개의 등록 상태를 확인했습니다.`, Boolean(failed));
  }
  catch (error) {
    try { await loadPreview(); if (runId) showRun(await api(`/api/invoices/${runId}`)); } catch { /* 기존 표시를 보존합니다. */ }
    message(error.message, true);
    $('registration-result').textContent = `조회 실패: ${error.message}\n등록 상태를 확인하지 못했습니다. 다시 조회해 주세요.`;
    $('registration-result').classList.add('is-error');
  }
  finally { checkingRegistration = false; setBusy(false); if (current) $('registration-result').scrollIntoView({ block: 'nearest' }); }
}
function newRun() {
  if (busy || !allowDiscard()) return;
  current = null; itemChanges.clear(); issueChanges.clear(); trackingChanges.clear(); $('import-form').reset(); $('search').value = ''; $('item-filter').value = 'all';
  $('naver-file-list').textContent = '선택한 파일이 없습니다. 여러 파일을 함께 올릴 수 있습니다.';
  $('courier-file-list').textContent = '송장번호가 들어 있는 택배사 출력파일을 선택하세요.';
  $('saved-files').hidden = true; $('import-form').hidden = false;
  $('source-date').value = selectedSourceDate; $('upload-section').hidden = false; $('preview-section').hidden = false; $('run-section').hidden = true; message(''); renderHistory(); refreshControls(); loadSourceDate({ restoreSaved: false });
}
function replaceFiles() {
  if (busy) return;
  $('import-form').reset(); $('carrier').value = current?.run.carrierCode || '';
  $('naver-file-list').textContent = '선택한 파일이 없습니다. 여러 파일을 함께 올릴 수 있습니다.';
  $('courier-file-list').textContent = '송장번호가 들어 있는 택배사 출력파일을 선택하세요.';
  $('import-form').hidden = false; refreshControls(); $('naver-files').focus();
}
function toggleHistory() {
  const collapsed = !$('history-body').hidden;
  $('history-body').hidden = collapsed;
  $('history-title').hidden = collapsed;
  document.querySelector('main.invoice-layout').classList.toggle('history-collapsed', collapsed);
  const label = collapsed ? '날짜·내역 펼치기' : '날짜·내역 접기';
  $('history-toggle').textContent = collapsed ? '›' : '‹ 접기';
  $('history-toggle').setAttribute('aria-label', label);
  $('history-toggle').title = label;
  $('history-toggle').setAttribute('aria-expanded', String(!collapsed));
}
$('import-form').addEventListener('submit', importFiles);
$('naver-files').addEventListener('change', () => fileList('naver-files', 'naver-file-list', '선택한 파일이 없습니다. 여러 파일을 함께 올릴 수 있습니다.'));
$('courier-files').addEventListener('change', () => fileList('courier-files', 'courier-file-list', '송장번호가 들어 있는 택배사 출력파일을 선택하세요.'));
$('carrier').addEventListener('change', refreshControls);
$('source-date').addEventListener('change', loadSourceDate);
$('new-run').addEventListener('click', newRun);
$('replace-files').addEventListener('click', replaceFiles);
$('history-toggle').addEventListener('click', toggleHistory);
$('save-button').addEventListener('click', saveReview);
$('replace-tracking-button').addEventListener('click', replaceCurrentTracking);
$('export-button').addEventListener('click', downloadRegistrationExcel);
$('pending-export-button').addEventListener('click', () => openAdditionalExport('pending'));
$('full-export-button').addEventListener('click', () => openAdditionalExport('all'));
$('invoice-action-close').addEventListener('click', () => $('invoice-action-dialog').close());
$('invoice-action-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('check-button').addEventListener('click', checkRegistration);
$('date-check-button').addEventListener('click', checkRegistration);
$('refresh-run').addEventListener('click', () => { if (!busy && current && allowDiscard()) loadRun(current.run.id); });
$('search').addEventListener('input', () => { if (current) renderItems(); });
$('item-filter').addEventListener('change', () => { if (current) renderItems(); });
async function refreshHistory() {
  if (busy) return;
  setBusy(true);
  try { await loadHistory(); }
  catch (error) { $('history-message').textContent = error.message; }
  finally { setBusy(false); }
}
$('history-reload').addEventListener('click', refreshHistory);
$('recent-runs').addEventListener('click', () => { if (!busy) { showRecentHistory = true; refreshHistory(); } });
window.addEventListener('beforeunload', event => { if (isDirty() || busy) { event.preventDefault(); event.returnValue = ''; } });
async function start() {
  $('source-date').value = selectedSourceDate;
  setBusy(true);
  try {
    const data = await api('/api/invoices/meta');
    for (const carrier of data.carriers || []) $('carrier').add(new Option(carrier.name, carrier.code));
  } catch { message('택배사 목록을 가져오지 못했습니다. 화면을 새로고침해 주세요.', true); }
  setBusy(false);
  const requestedRun = new URLSearchParams(window.location.search).get('run');
  if (requestedRun && /^[1-9]\d*$/.test(requestedRun) && Number.isSafeInteger(Number(requestedRun))) {
    await loadRun(Number(requestedRun));
  } else {
    await loadSourceDate();
  }
}
start();
