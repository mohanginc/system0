'use strict';
const $ = id => document.getElementById(id);
const count = value => Number(value || 0).toLocaleString('ko-KR');
const formatTime = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
const workDate = (value = Date.now()) => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
let current = null, runs = [], busy = false, checkingRegistration = false;
let dayBatches = [], previewOrders = [], previewReady = false, selectedSourceDate = workDate();
let showRecentHistory = false;
const selectedBatches = new Map();
const itemChanges = new Map(), issueChanges = new Map();
const registrationLabels = { unchecked: '등록 미조회', pending: '등록 미확인', complete: '등록 확인 완료', conflict: '송장 불일치' };
const historyRegistrationLabels = { unchecked: '네이버 등록 미조회', pending: '네이버 미등록', partial: '네이버 일부 등록', complete: '네이버 등록 확인 완료', conflict: '네이버 송장 확인 필요' };
const outsideLabels = { external_registered: '네이버 등록 확인 완료', pending: '발송대기 · 파일 누락 가능성', canceled: '취소 확인', returned: '반품 확인', attention: '일부 등록·상태 확인 필요', unknown: '등록 여부 미확인' };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, error = false) {
  $('message').textContent = text; $('message').hidden = !text; $('message').classList.toggle('error', error);
}
function isDirty() { return itemChanges.size > 0 || issueChanges.size > 0; }
function draftItem(item) { return { ...item, ...itemChanges.get(String(item.id)) }; }
function draftIssue(issue) { return { ...issue, ...issueChanges.get(issue.key) }; }
function scopeUnavailable() { return current && (current.scopeRequired || !Array.isArray(current.orders)); }
function downloadItems() { return (current?.items || []).filter(item => item.decision === 'include' && item.registrationState !== 'complete' && !item.sourceRegistered); }
function storedDownloadMode() { return current?.run.savedFileAvailable ? 'saved' : 'rebuild'; }
function primaryDownloadMode() { return current?.run.generatedAt && !downloadItems().length ? storedDownloadMode() : 'export'; }
function refreshControls() {
  const dirty = isDirty(), unresolved = (current?.issues || []).filter(issue => issue.reviewRequired !== false && !issue.resolved).length;
  const exportable = downloadItems().length;
  const blocked = (current?.items || []).some(item => item.decision === 'include' && (item.registrationState === 'conflict'
    || (current.issues || []).some(issue => issue.blocking && item.issues.includes(issue.key))));
  const mode = primaryDownloadMode(), included = (current?.items || []).filter(item => item.decision === 'include').length;
  const needsReview = unresolved > 0 || blocked || scopeUnavailable() || current?.rematchRequired;
  for (const control of document.querySelectorAll('button, input, select, textarea')) control.disabled = busy || control.dataset.locked === 'true';
  $('import-button').disabled = busy || !previewReady || !$('naver-files').files.length || !$('courier-files').files.length || !$('carrier').value;
  $('save-button').disabled = busy || !dirty || scopeUnavailable() || current?.rematchRequired;
  $('export-button').disabled = busy || !current || dirty || (mode !== 'saved' && (needsReview || !(mode === 'rebuild' ? included : exportable)));
  $('export-button').textContent = mode === 'saved' ? '생성한 엑셀 다시 받기' : mode === 'rebuild' ? '현재 매칭 엑셀 받기' : '네이버 업로드용 엑셀';
  $('redownload-button').hidden = !current?.run.generatedAt || mode !== 'export';
  $('redownload-button').disabled = busy || dirty || (storedDownloadMode() !== 'saved' && (needsReview || !included));
  $('redownload-button').textContent = storedDownloadMode() === 'saved' ? '생성한 엑셀 다시 받기' : '현재 매칭 엑셀 받기';
  $('check-button').disabled = busy || !current || dirty || (!current.items.length && !current.outsideOrders?.length) || scopeUnavailable() || current.rematchRequired;
  $('check-button').textContent = checkingRegistration ? '조회 중…' : '등록 상태 확인';
  $('refresh-run').disabled = busy || !current;
  $('dirty-note').textContent = dirty ? '검토 내용이 변경되었습니다. 저장해 주세요.' : '';
  if (current) {
    const generated = Boolean(current.run.generatedAt);
    $('run-state').textContent = dirty ? `${generated ? '파일 생성됨' : '작성 중'} · 검토 내용 저장 전` : generated ? '파일 생성됨' : '작성 중 · 저장됨';
    $('run-state').classList.toggle('is-generated', generated); $('run-state').classList.toggle('is-dirty', dirty);
  }
  $('save-button').textContent = busy && dirty ? '저장 중…' : '검토 내용 저장';
  if (current) $('export-note').textContent = dirty ? '변경한 검토 내용을 먼저 저장하세요.'
    : mode === 'saved' ? '이미 생성한 파일을 그대로 다시 내려받습니다. 네이버 등록 상태는 아래에서 확인하세요.'
    : current.rematchRequired ? '다른 날짜의 주문까지 확인하려면 같은 ①·③ 파일을 다시 선택해 매칭하세요.'
    : unresolved ? '주문 행의 경고를 확인한 뒤 검토 내용을 저장하세요. 메모는 선택 사항입니다.'
    : blocked ? '연결 근거가 부족하거나 등록 송장이 다른 포함 항목을 보류·제외해 주세요.'
    : mode === 'rebuild' ? `이전 생성 파일은 보관되지 않아 현재 저장된 매칭 ${count(included)}건으로 다시 만듭니다.\n등록 완료 건도 포함됩니다.`
    : !exportable ? '새로 엑셀로 만들 상품주문이 없습니다. 등록 완료·보류·제외 상태를 확인하세요.'
    : `네이버 상품주문 ${count(exportable)}건 · 보류·제외·등록 확인 완료 건은 포함하지 않습니다.\n다운로드만으로 등록 완료가 되지 않습니다.`;
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
  current = null; itemChanges.clear(); issueChanges.clear(); $('run-section').hidden = true; $('preview-section').hidden = false;
  $('saved-files').hidden = true; $('import-form').hidden = false; $('import-form').reset();
  $('naver-file-list').textContent = '선택한 파일이 없습니다. 여러 파일을 함께 올릴 수 있습니다.';
  $('courier-file-list').textContent = '송장번호가 들어 있는 택배사 출력파일을 선택하세요.';
  renderHistory(); message('');
}
function sourceLocation(source) {
  if (!source) return '';
  const batch = selectedBatches.get(source.batchId) || current?.batches?.find(batch => batch.id === source.batchId), date = source.batchCreatedAt || batch?.createdAt;
  return [date ? `작업 ${formatTime(date)}` : '', source.sourceFile ? `파일: ${source.sourceFile}` : '',
    [source.sourceSheet ? `시트: ${source.sourceSheet}` : '', source.sourceRow !== undefined ? `${source.sourceRow}행` : ''].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
}
function orderGroups(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = order.sourceType === 'naver_only' ? 'naver_only' : order.batchId;
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
  heading.append(element('strong', group.sourceType === 'naver_only' ? '① 네이버에만 있는 주문 · ② 확인한 주문 자료 없음' : `작업 ${formatTime(sourceTime)}`));
  if (date) heading.append(element('span', otherDate ? date < selectedSourceDate ? '이전 날짜 주문' : '다른 날짜 주문' : '선택한 날짜', 'order-date-badge'));
  heading.append(element('span', `파일: ${files.join(' · ') || batch?.name || '원본 정보 없음'}`), element('small', `${count(group.orders.length)}행`));
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
    if (order.latestRunId && (order.itemIds?.length || order.evidence)) {
      const link = element('button', `${order.processingDate || ''} 처리 내역`, 'text-button'); link.type = 'button';
      link.addEventListener('click', () => { if (!busy && allowDiscard()) loadRun(order.latestRunId); }); state.append(link);
    }
    row.append(recipient, product, location, state); fragment.append(row);
    }
  }
  $('preview-rows').replaceChildren(fragment); $('preview-count').textContent = `${count(previewOrders.length)}행`;
}
async function loadPreview() {
  previewReady = false;
  if (!selectedBatches.size) { previewOrders = []; previewReady = true; renderPreview(); $('preview-message').textContent = '이 날짜에 등록한 주문이 없어도 파일을 올리면 다른 날짜의 주문을 찾아 매칭합니다.'; return; }
  $('preview-message').textContent = '해당 날짜의 확인한 주문 전체를 불러오고 있습니다.';
  try {
    const query = new URLSearchParams({ batchIds: JSON.stringify([...selectedBatches.keys()]) });
    const data = await api(`/api/invoices/orders?${query}`);
    if (!Array.isArray(data.orders)) throw new Error('현재 실행 중인 서버가 이전 버전입니다. system0 서버를 재시작해 주세요.');
    previewOrders = data.orders; previewReady = true; renderPreview(); $('preview-message').textContent = '선택한 날짜의 원본 주문과 최근 연결 결과입니다. 파일 매칭은 날짜와 관계없이 ① 네이버 주문에 해당하는 자료를 찾습니다.';
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
    button.append(element('strong', `파일 생성 ${formatTime(run.generatedAt)}`), element('small', run.carrierName || '네이버'));
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
  const data = await api(`/api/invoices${query}`); runs = (data.runs || []).filter(run => run.generatedAt); renderHistory();
}
function saveItemDraft(item, fields) {
  const key = String(item.id), next = { ...draftItem(item), ...fields };
  if (next.decision === item.decision && (next.note || '') === (item.note || '')) itemChanges.delete(key);
  else itemChanges.set(key, { id: item.id, decision: next.decision, note: next.note || '' });
  for (const control of document.querySelectorAll('[data-item-id]')) if (control.dataset.itemId === key && control !== document.activeElement) control.value = control.classList.contains('item-decision') ? next.decision : next.note || '';
  refreshControls();
}
function warningReview(issues, showLocation = false) {
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
    if (issue.kind === 'registration_recheck') {
      description.append(element('small', '하단의 등록 상태 확인을 눌러 현재 상태를 다시 조회하세요.'));
      row.append(description); return row;
    }
    if (!missingOrder) description.append(element('small', issue.blocking
      ? `${issue.resolved ? '확인 내용이 저장되었습니다. ' : ''}관련 상품주문은 보류·제외해야 합니다.`
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
function appendWarnings(target, issues) {
  const groups = new Map();
  for (const issue of issues) {
    const draft = draftIssue(issue), key = JSON.stringify([issue.message, Boolean(issue.blocking), Boolean(draft.resolved), draft.note || '']);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }
  for (const group of groups.values()) target.append(warningReview(group));
}
function warningsForOrder(order) {
  return (current.issues || []).filter(issue => (order.issues || []).includes(issue.key));
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
  const assigned = new Set(displayedOrders().flatMap(order => warningsForOrder(order).map(issue => issue.key)));
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
  for (const issueKey of item.issues || []) {
    const issue = current.issues.find(value => value.key === issueKey);
    if (issue) lines.push(issue.message);
  }
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
function shipmentHistory(items) {
  const shipments = new Map();
  for (const item of items) for (const shipment of item.physicalShipments || []) if (!shipments.has(shipment.trackingNumber)) shipments.set(shipment.trackingNumber, shipment);
  if (!shipments.size) return null;
  const history = element('details'); history.append(element('summary', `전체 송장 이력 ${count(shipments.size)}건`));
  for (const shipment of shipments.values()) {
    const lines = [`${shipment.trackingNumber} · ${shipment.valid === true ? '유효' : shipment.valid === false ? '이전 송장' : '유효 여부 확인 필요'}`];
    if (shipment.round) lines.push(`차수 ${shipment.round}`);
    if (shipment.originalTrackingNumber) lines.push(`원송장 ${shipment.originalTrackingNumber}`);
    if (shipment.issueCount !== null && shipment.issueCount !== undefined) lines.push(`발행횟수 ${shipment.issueCount}`);
    if (shipment.printedAt) lines.push(`출력 ${shipment.printedAt}`);
    if (shipment.replacedBy) lines.push(`교체 송장 ${shipment.replacedBy}`);
    for (const source of shipment.sources || []) lines.push(sourceLocation(source));
    history.append(element('p', lines.join('\n')));
  }
  return history;
}
function displayedOrders() {
  const orders = scopeUnavailable() ? previewOrders : current?.orders || previewOrders;
  return [...orders.filter(order => order.sourceType === 'naver_only'), ...orders.filter(order => order.sourceType !== 'naver_only')];
}
function renderItems() {
  const query = $('search').value.trim().toLocaleLowerCase(), filter = $('item-filter').value;
  const allOrders = displayedOrders();
  const orders = allOrders.filter(order => {
    const linked = current.items.filter(item => order.itemIds.includes(item.id)).map(draftItem);
    const matches = filter === 'all' || (filter === 'attention' ? Boolean(matchClass(order.state)) || linked.some(item => item.decision === 'hold')
      : filter === 'registered' ? order.state === 'complete' : filter === 'include' ? order.trackingNumbers.length > 0 : linked.some(item => item.decision === filter));
    return matches && (!query || [order.recipient, order.phone, order.cleanedName, order.originalName, order.optionName, order.orderId, order.internalId, ...order.trackingNumbers, ...linked.map(item => item.productOrderId)].join(' ').toLocaleLowerCase().includes(query));
  });
  const fragment = document.createDocumentFragment();
  for (const group of orderGroups(orders)) {
    fragment.append(groupHeading(group, 5));
    for (const order of group.orders) {
    const linked = current.items.filter(item => order.itemIds.includes(item.id)), row = element('tr', undefined, matchClass(order.state));
    row.classList.toggle('is-excluded', order.state === 'excluded');
    row.classList.toggle('combined-order', linked.length > 1);
    const recipient = element('td'); recipient.append(element('strong', order.recipient || '수취인 정보 없음')); if (order.phone) recipient.append(element('small', order.phone));
    for (const item of linked) recipient.append(element('small', item.productOrderId));
    const location = [order.source?.sourceFile, [order.source?.sourceSheet, order.source?.sourceRow !== undefined ? `${order.source.sourceRow}행` : ''].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const product = element('td'); product.append(element('strong', order.cleanedName || order.originalName || '상품명 미정리'));
    if (order.sourceType === 'naver_only' && order.optionName) product.append(element('small', `선택 옵션: ${order.optionName}`));
    product.append(element('small', `${order.sourceType === 'naver_only' ? '① ' : '② '}${location}`, 'source-location'));
    const details = element('details'); details.append(element('summary', '주문 연결 근거'), element('p', [...new Set(linked.map(sourceDescription))].filter(Boolean).join('\n') || (order.internalId ? `내부 출고번호: ${order.internalId}` : order.reason || '연결된 자료가 없습니다.'))); product.append(details);
    const tracking = element('td');
    for (const number of order.trackingNumbers) tracking.append(element('strong', number));
    if (!order.trackingNumbers.length) tracking.append(element('span', order.state === 'not_matched' ? '송장 매칭 전' : '대응 송장 없음'));
    if (order.courierRows?.length) {
      const sources = element('details'); sources.append(element('summary', '③ 송장 원본 위치'));
      for (const source of order.courierRows) sources.append(element('p', [source.trackingNumber ? `송장번호: ${source.trackingNumber}` : '', sourceLocation(source)].filter(Boolean).join('\n')));
      tracking.append(sources);
    }
    const history = shipmentHistory(linked); if (history) tracking.append(history);
    const review = element('td');
    if (!['ready', 'complete'].includes(order.state)) review.append(element('span', matchLabel(order.state), `match-state ${matchClass(order.state)}`));
    const warnings = warningsForOrder(order);
    if (order.reason && !warnings.length && !['ready', 'complete'].includes(order.state)) review.append(element('small', order.reason, 'match-reason'));
    for (const item of linked) {
      if (linked.length > 1) review.append(element('small', `상품주문번호 ${item.productOrderId}`));
      review.append(reviewControls(item));
    }
    appendWarnings(review, warnings);
    if (!linked.length && order.state === 'not_matched') review.append(element('small', '아직 이 주문에 송장을 매칭하지 않았습니다.'));
    const registration = element('td');
    for (const item of linked) {
      const state = item.registrationState || 'unchecked';
      if (linked.length > 1) registration.append(element('small', item.productOrderId));
      registration.append(element('span', registrationLabels[state] || '확인 필요', `registration-badge ${state === 'complete' ? 'registered' : state}`));
      if (item.registrationNote) registration.append(element('small', item.registrationNote));
      if (item.sourceRegistered && state !== 'complete') registration.append(element('small', '원본에 동일 송장 있음 · 중복 다운로드 제외'));
    }
    if (!linked.length) registration.append(element('small', order.state === 'not_matched' ? '매칭 전' : '등록 대상 미연결'));
    row.append(recipient, product, tracking, review, registration); fragment.append(row);
    }
  }
  $('item-rows').replaceChildren(fragment); $('items-empty').hidden = Boolean(orders.length);
  $('visible-count').textContent = `표시 ${count(orders.length)} / ${count(allOrders.length)}행 · 원본 작업별 표시 · 합배송은 한 행에 여러 상품주문 표시`;
  renderOutsideTarget();
  renderUnmatched();
}
function renderOutsideTarget() {
  const relatedRows = new Set((current.orders || []).map(order => order.rowId));
  const orders = [...(current.outsideOrders || [])], represented = new Set([...relatedRows, ...orders.map(order => order.rowId)]);
  for (const order of previewOrders) if (!represented.has(order.rowId)) orders.push(order);
  const fragment = document.createDocumentFragment(), states = {};
  for (const order of orders) states[order.state] = (states[order.state] || 0) + 1;
  $('outside-target-section').hidden = scopeUnavailable() || !orders.length;
  $('outside-target-count').textContent = `${count(orders.length)}행`;
  const unverified = orders.length - ['external_registered', 'pending', 'canceled', 'returned', 'attention'].reduce((sum, state) => sum + (states[state] || 0), 0);
  $('outside-target-summary').textContent = [states.external_registered && `네이버 등록 확인 ${count(states.external_registered)}`,
    states.pending && `발송대기 ${count(states.pending)}`, states.canceled && `취소 ${count(states.canceled)}`,
    states.returned && `반품 ${count(states.returned)}`, states.attention && `상태 확인 필요 ${count(states.attention)}`,
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
  current = data; itemChanges.clear(); issueChanges.clear(); $('upload-section').hidden = false; $('preview-section').hidden = true; $('run-section').hidden = false;
  renderPreview();
  const dates = [...new Set((data.batches || []).map(batch => workDate(batch.createdAt)))].sort();
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
  $('run-description').textContent = `${formatTime(data.run.createdAt)} · 네이버 스마트스토어 · ${data.run.carrierName || ''}\n${fileSummary || '선택한 확인한 주문 작업 기준으로 연결한 결과입니다.'}${data.run.generatedAt ? `\n파일 생성: ${formatTime(data.run.generatedAt)} · 네이버 등록 상태는 별도로 확인합니다.` : '\n작성 내용은 보관되며, 파일을 생성하기 전에는 왼쪽 생성 내역에 표시하지 않습니다.'}`;
  $('total-count').textContent = count(data.items.length); $('ready-count').textContent = count(data.summary.connected ?? data.items.filter(item => item.sourceRows?.length).length);
  const sameDate = data.summary.selectedDate ?? data.items.filter(item => item.sourceDate === selectedSourceDate).length;
  const otherDate = data.summary.otherDate ?? data.items.filter(item => item.sourceDate && item.sourceDate !== selectedSourceDate).length;
  const unknownDate = data.summary.unknownDate ?? data.items.filter(item => !item.sourceDate).length;
  $('match-date-summary').textContent = `선택한 날짜 ${count(sameDate)}건 + 다른 날짜 ${count(otherDate)}건${unknownDate ? ` + 원본 날짜 확인 필요 ${count(unknownDate)}건` : ''} = 이번 처리 대상 ${count(data.items.length)}건`;
  const missing = data.summary.missingSaved ?? data.items.filter(item => !item.sourceRows?.length).length;
  $('attention-count').textContent = count(missing); $('registered-count').textContent = count(data.items.filter(item => item.registrationState === 'complete' && item.statusFresh).length);
  $('naver-missing-note').hidden = !missing;
  $('naver-missing-note').textContent = `① 최종 네이버 주문 중 ${count(missing)}건에 대응하는 ② 확인한 주문 자료가 없습니다. 아래 첫 그룹에서 송장 누락 여부를 확인하세요. 보류·제외된 상품주문은 엑셀에 포함하지 않습니다.`;
  $('last-check').textContent = data.run.statusCheckedAt ? `마지막 등록 조회: ${formatTime(data.run.statusCheckedAt)}` : '아직 네이버 등록 상태를 조회하지 않았습니다.';
  renderRegistrationResult();
  renderIssues(); if (unavailable) $('issues-section').hidden = true; renderItems(); renderHistory(); refreshControls();
}
async function loadRun(id) {
  setBusy(true); message('송장 매칭 결과를 불러오고 있습니다.');
  try {
    const data = await api(`/api/invoices/${encodeURIComponent(id)}`);
    const date = data.run.sourceDate || workDate(data.batches?.[0]?.createdAt || data.run.createdAt);
    if (date !== selectedSourceDate) { $('source-date').value = date; await loadSourceDate({ discardConfirmed: true, restoreSaved: false }); setBusy(true); }
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
  const body = { changes: [...itemChanges.values()], issueResolutions: resolutions.filter(issue => issue.resolved).map(({ key, note }) => ({ key, note })) };
  setBusy(true); message('검토 내용을 저장하고 있습니다.');
  try { showRun(await api(`/api/invoices/${current.run.id}/items`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })); message('검토 내용을 저장했습니다.'); await loadHistory(); }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
async function downloadExcel(mode = primaryDownloadMode()) {
  if (busy || !current || isDirty()) return;
  let downloadStarted = false;
  setBusy(true); message(mode === 'saved' ? '보관된 엑셀을 내려받고 있습니다.' : '네이버 업로드용 엑셀을 만들고 있습니다.');
  try {
    const route = mode === 'export' ? 'export' : mode === 'rebuild' ? 'download?rebuild=1' : 'download';
    const response = await fetch(`/api/invoices/${current.run.id}/${route}`, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || '엑셀을 만들지 못했습니다.'); }
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = element('a');
    const disposition = response.headers.get('content-disposition') || '', match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    link.href = url; link.download = match ? decodeURIComponent(match[1]) : `네이버_송장등록_${workDate(current.run.createdAt)}.xlsx`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    downloadStarted = true; showRun(await api(`/api/invoices/${current.run.id}`)); showRecentHistory = true; await loadHistory();
    message(mode === 'saved' ? '보관된 엑셀의 다운로드를 요청했습니다.' : mode === 'rebuild' ? '등록 완료 건을 포함한 현재 매칭으로 엑셀을 다시 만들었습니다.' : '엑셀을 생성해 다운로드를 요청했습니다. 스마트스토어 업로드 후 ‘등록 상태 확인’을 눌러 주세요.');
  } catch (error) { message(downloadStarted ? `엑셀 다운로드 요청은 완료했지만 생성 내역을 갱신하지 못했습니다. 왼쪽 새로고침으로 확인해 주세요.\n${error.message}` : error.message, true); }
  finally { setBusy(false); }
}
function renderRegistrationResult() {
  const result = $('registration-result'); result.classList.remove('is-error');
  if (!current?.run.statusCheckedAt) { result.textContent = '이번 처리 대상은 아직 등록 상태를 조회하지 않았습니다.'; return; }
  const items = current.items || [], counts = { complete: 0, pending: 0, conflict: 0, unchecked: 0 };
  for (const item of items) counts[item.statusFresh ? item.registrationState : 'unchecked']++;
  result.textContent = `${formatTime(current.run.statusCheckedAt)} 조회 · 상품주문 ${count(items.length)}건\n등록 완료 ${count(counts.complete)} · 미등록 ${count(counts.pending)} · 충돌 ${count(counts.conflict)}${counts.unchecked ? ` · 재조회 필요 ${count(counts.unchecked)}` : ''}`;
}
async function checkRegistration() {
  if (busy || !current || isDirty()) return;
  checkingRegistration = true;
  $('registration-result').classList.remove('is-error'); $('registration-result').textContent = '네이버 등록 상태를 조회하고 있습니다…';
  setBusy(true); message('네이버에 등록된 현재 송장을 조회하고 있습니다. 주문 상태는 변경하지 않습니다.');
  try {
    showRun(await api(`/api/invoices/${current.run.id}/check`, { method: 'POST' }));
    message('등록 상태를 조회했습니다. 미확인·불일치 항목을 확인해 주세요.');
    try { await loadHistory(); } catch { message('등록 상태 조회는 완료했지만 왼쪽 생성 내역을 갱신하지 못했습니다. 새로고침으로 확인해 주세요.', true); }
  }
  catch (error) {
    try { showRun(await api(`/api/invoices/${current.run.id}`)); } catch { /* 기존 결과를 보존하고 조회 실패를 안내합니다. */ }
    message(`${error.message}\n이번 처리 대상의 조회를 완료하지 못했습니다. 파일 밖 주문의 조회 결과는 아래 별도 목록에서 확인하세요.`, true);
    $('registration-result').textContent = `조회 실패: ${error.message}\n등록 상태를 확인하지 못했습니다. 다시 조회해 주세요.`;
    $('registration-result').classList.add('is-error');
  }
  finally { checkingRegistration = false; setBusy(false); $('registration-result').scrollIntoView({ block: 'nearest' }); }
}
function newRun() {
  if (busy || !allowDiscard()) return;
  current = null; itemChanges.clear(); issueChanges.clear(); $('import-form').reset(); $('search').value = ''; $('item-filter').value = 'all';
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
$('export-button').addEventListener('click', () => downloadExcel());
$('redownload-button').addEventListener('click', () => downloadExcel(storedDownloadMode()));
$('check-button').addEventListener('click', checkRegistration);
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
  await loadSourceDate();
}
start();
