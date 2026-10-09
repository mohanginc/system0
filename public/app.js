'use strict';
const $ = (id) => document.getElementById(id);
const labels = { pending: '미정리', review: '검수 대기', attention: '확인 필요', confirmed: '검수 완료' };
let files = [], current = null, groups = [], historyBatches = [], busy = false, keyConfigured = false, visibleLimit = 80;
const selected = new Set(), drafts = new Map(), deletedRowIds = new Set();
const workDate = (value = Date.now()) => new Date(new Date(value).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
  $('message').hidden = !text;
}
async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || data.message || `요청을 처리하지 못했습니다 (${response.status}).`);
  }
  return response.json();
}
function json(method, body) { return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function groupRows(rows) {
  const result = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.originalName, row.optionName, row.cleanedName, row.status, row.reviewNote]);
    if (!result.has(key)) result.set(key, { ...row, ids: [], sources: new Set() });
    const group = result.get(key);
    group.ids.push(row.id); group.sources.add(row.sourceFile);
  }
  return [...result.values()];
}
function values(group) { return { ...group, ...(drafts.get(group.id) || {}) }; }
function hasChanges() { return !!(drafts.size || deletedRowIds.size); }
function remainingGroups() { return groups.filter(group => !deletedRowIds.has(group.id)); }
function filteredGroups() {
  const search = $('search').value.trim().toLocaleLowerCase(), status = $('status-filter').value;
  return remainingGroups().filter((group) => {
    const row = values(group);
    return (status === 'all' || row.status === status) && `${row.originalName} ${row.optionName} ${row.cleanedName} ${row.reviewNote}`.toLocaleLowerCase().includes(search);
  });
}
function updateMetrics(detail = current) {
  if (!detail) return;
  const list = detail === current ? remainingGroups().map(values) : groupRows(detail.rows);
  const count = detail.rows.filter(row => detail !== current || !deletedRowIds.has(row.id)).length;
  $('total-count').textContent = count.toLocaleString();
  $('name-count').textContent = list.length.toLocaleString();
  $('confirmed-count').textContent = list.filter((row) => row.status === 'confirmed').length.toLocaleString();
  $('attention-count').textContent = list.filter((row) => row.status === 'attention').length.toLocaleString();
}
function updateControls() {
  const locked = busy || !!current?.batch.running;
  for (const control of document.querySelectorAll('button,input,select,textarea')) control.disabled = locked;
  $('import-button').disabled = locked || !files.length;
  $('batch-select').disabled = locked || $('batch-select').options.length <= 1;
  $('save-button').disabled = locked || !hasChanges();
  $('confirm-button').disabled = locked || !selected.size;
  for (const control of document.querySelectorAll('[data-delete-control]')) {
    control.disabled = locked || control.dataset.running === 'true';
    control.title = control.dataset.running === 'true' ? '상품명 정리가 끝난 뒤 삭제할 수 있습니다.' : '';
  }
  $('delete-batch-button').disabled ||= !current;
  $('delete-selected-button').disabled ||= !selected.size;
  const pending = remainingGroups().filter((group) => !group.cleanedName && (!selected.size || selected.has(group.id)));
  $('normalize-button').disabled = locked || !keyConfigured || !pending.length || hasChanges();
  $('normalize-button').textContent = selected.size ? `선택 상품명 정리 (${pending.length})` : `미정리 상품명 정리 (${pending.length})`;
  $('export-button').disabled = locked || !current || !current.rows.length || current.rows.some((row) => !row.cleanedName) || hasChanges();
  $('dirty-indicator').textContent = [drafts.size ? `저장하지 않은 수정 ${drafts.size}건` : '', deletedRowIds.size ? `삭제 예정 주문 ${deletedRowIds.size}행` : ''].filter(Boolean).join(' · ');
  if (current) {
    const unconfirmed = groups.filter((row) => row.status !== 'confirmed').length;
    const format = $('export-kind').value === 'names' ? '검수용 목록의 B열에 정리된 제품명이 들어갑니다.'
      : `삭제한 주문을 제외하고 원본 컬럼과 나머지 행 순서를 유지한 XLSX를 만듭니다.${current.batch.fileCount > 1 ? ' 파일별 결과를 ZIP으로 다운로드합니다.' : ''}`;
    $('export-description').textContent = hasChanges() ? '수정·삭제 내용을 저장한 후 다운로드할 수 있습니다.' : !current.rows.length ? '남은 주문이 없어 다운로드할 수 없습니다.' : current.rows.some((row) => !row.cleanedName) ? '모든 상품명을 정리한 후 다운로드할 수 있습니다.' : `${format}${unconfirmed ? ` 검수 전 상품명 ${unconfirmed}건이 포함됩니다.` : ''}`;
  }
}
function applyDetail(detail) {
  current = detail; groups = groupRows(detail.rows); drafts.clear(); selected.clear(); deletedRowIds.clear();
  $('workspace').hidden = false; $('empty-state').hidden = true; $('day-overview').hidden = true;
  $('batch-description').textContent = `${detail.batch.name} · 파일 ${detail.batch.fileCount}개 · 같은 상품명은 한 번에 검수합니다.`;
  $('batch-select').value = String(detail.batch.id);
  $('batch-date').value = workDate(detail.batch.createdAt);
  updateMetrics(); renderRows();
}
function draft(group, change) {
  const row = values(group);
  drafts.set(group.id, { ids: group.ids, cleanedName: row.cleanedName || '', reviewNote: row.reviewNote || '', status: row.status, ...change });
  updateControls();
}
async function saveReview(targets, status = 'confirmed') {
  if (!current || busy || current.batch.running || !targets.length) return;
  if (targets.some(group => !values(group).cleanedName.trim())) {
    renderRows(); message('상품명을 입력하거나 정리한 뒤 검수 완료를 선택하세요.', true); return;
  }
  const changes = targets.flatMap(group => {
    const row = values(group);
    return group.ids.map(id => ({ id, cleanedName: row.cleanedName, reviewNote: row.reviewNote, status }));
  });
  setBusy(true); message('검수 내용을 저장하고 있습니다.');
  try {
    const detail = await api(`/api/batches/${current.batch.id}/rows`, json('PATCH', { changes }));
    current = detail;
    const saved = new Map(detail.rows.map(row => [row.id, row]));
    targets.forEach(group => {
      Object.assign(group, saved.get(group.id)); drafts.delete(group.id); selected.delete(group.id);
    });
    if (!hasChanges()) applyDetail(detail);
    else { updateMetrics(); renderRows(); }
    message(status === 'confirmed' ? '검수 완료와 저장을 마쳤습니다.' : '검수 완료를 해제하고 저장했습니다.');
    try { await loadHistory(); }
    catch (error) { message(`검수 내용은 저장했지만 작업 목록을 갱신하지 못했습니다. ${error.message}`, true); }
  } catch (error) {
    renderRows(); message(`검수 내용을 저장하지 못했습니다. ${error.message}`, true);
  } finally { setBusy(false); }
}
function cell(text, className) {
  const element = document.createElement('div'); element.className = className; element.textContent = text; return element;
}
function renderRows() {
  const filtered = filteredGroups(), visible = filtered.slice(0, visibleLimit), body = $('rows');
  body.replaceChildren();
  for (const group of visible) {
    const row = values(group), tr = document.createElement('tr');
    const selectCell = tr.insertCell(), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(group.id); checkbox.setAttribute('aria-label', `${row.originalName} 선택`);
    checkbox.addEventListener('change', () => { checkbox.checked ? selected.add(group.id) : selected.delete(group.id); updateControls(); updateSelectAll(); });
    selectCell.append(checkbox);
    const originalCell = tr.insertCell(); originalCell.append(cell(row.originalName, 'original-name'));
    if (row.optionName) originalCell.append(cell(`옵션 · ${row.optionName}`, 'option-name'));
    originalCell.append(cell(`주문 ${group.ids.length}행 · ${[...group.sources].slice(0, 2).join(', ')}${group.sources.size > 2 ? ` 외 ${group.sources.size - 2}개 파일` : ''}`, 'source-info'));
    const nameCell = tr.insertCell(), nameInput = document.createElement('textarea');
    nameInput.value = row.cleanedName || ''; nameInput.className = 'name-input'; nameInput.placeholder = '상품명 정리 후 표시됩니다';
    nameInput.setAttribute('aria-label', `${row.originalName}의 정리된 제품명`);
    nameInput.addEventListener('input', () => {
      const status = values(group).status === 'pending' && nameInput.value.trim() ? 'review' : values(group).status;
      draft(group, { cleanedName: nameInput.value, status }); statusBadge.textContent = labels[status]; statusBadge.className = `status ${status}`;
    });
    nameCell.append(nameInput);
    const noteCell = tr.insertCell(), noteInput = document.createElement('textarea');
    noteInput.value = row.reviewNote || ''; noteInput.className = 'note-input'; noteInput.placeholder = '필요한 검수 메모';
    noteInput.setAttribute('aria-label', `${row.originalName}의 검수 메모`);
    noteInput.addEventListener('input', () => draft(group, { reviewNote: noteInput.value })); noteCell.append(noteInput);
    const statusCell = tr.insertCell(), statusBadge = cell(labels[row.status], `status ${row.status}`), confirmLabel = document.createElement('label'), confirm = document.createElement('input');
    confirm.type = 'checkbox'; confirm.checked = row.status === 'confirmed'; confirmLabel.className = 'confirmed-checkbox';
    confirm.addEventListener('change', () => {
      const status = confirm.checked ? 'confirmed' : (group.status === 'attention' ? 'attention' : 'review');
      saveReview([group], status);
    });
    const remove = document.createElement('button'); remove.textContent = '항목 삭제'; remove.className = 'delete-button item-delete'; remove.dataset.deleteControl = '';
    remove.setAttribute('aria-label', `${row.originalName} 항목 삭제`);
    remove.addEventListener('click', () => deleteItems([group]));
    confirmLabel.append(confirm, document.createTextNode('검수 완료')); statusCell.append(statusBadge, confirmLabel, remove); body.append(tr);
  }
  $('no-results').hidden = !!visible.length;
  $('no-results').textContent = remainingGroups().length ? '조건에 맞는 항목이 없습니다.' : deletedRowIds.size ? '모든 항목을 삭제 대상으로 선택했습니다. 수정 내용 저장을 눌러 반영하세요.' : '남은 주문 항목이 없습니다. 새 주문 파일은 새 작업으로 불러오세요.';
  $('visible-count').textContent = `${filtered.length.toLocaleString()}개 항목 중 ${visible.length.toLocaleString()}개 표시`;
  $('show-more').hidden = filtered.length <= visibleLimit; updateSelectAll(); updateControls();
}
function updateSelectAll() {
  const visible = filteredGroups().slice(0, visibleLimit);
  $('select-all').checked = !!visible.length && visible.every((row) => selected.has(row.id));
  $('select-all').indeterminate = visible.some((row) => selected.has(row.id)) && !$('select-all').checked;
}
function setBusy(value, text = '') { busy = value; if (text) $('progress').textContent = text; updateControls(); }
async function loadHistory() {
  const date = $('batch-date').value || workDate();
  $('batch-date').value = date;
  const data = await api(`/api/batches?date=${date}`), select = $('batch-select');
  const batches = data.batches.filter(batch => workDate(batch.createdAt) === date);
  historyBatches = batches;
  select.replaceChildren(new Option(batches.length ? '작업을 선택하세요' : '해당 날짜의 작업 없음', ''));
  if (batches.length) select.add(new Option('모든 작업 보기', 'all'));
  for (const batch of batches) {
    const time = new Date(batch.createdAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
    select.add(new Option(`${time} · ${batch.name} · ${batch.rowCount.toLocaleString()}행`, String(batch.id)));
  }
  if (current) select.value = String(current.batch.id);
  updateControls(); return batches;
}
async function showDayOverview() {
  const details = await Promise.all(historyBatches.map(batch => api(`/api/batches/${batch.id}`)));
  clearWorkspace();
  if (!details.length) return;
  const body = $('day-rows');
  body.replaceChildren();
  for (const detail of details) {
    const header = body.insertRow(); header.className = 'day-job-header';
    const heading = header.insertCell(); heading.colSpan = 4;
    const title = document.createElement('div'); title.className = 'day-job-title';
    const time = new Date(detail.batch.createdAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
    const label = document.createElement('button'); label.className = 'job-toggle'; label.setAttribute('aria-expanded', 'false');
    const titleText = `${time} · ${detail.batch.name} · 주문 ${detail.rows.length.toLocaleString()}행`;
    label.textContent = `▶ ${titleText}`;
    const open = document.createElement('button'); open.textContent = '작업 열기';
    open.addEventListener('click', () => openBatch(String(detail.batch.id)));
    const remove = document.createElement('button'); remove.textContent = '작업 삭제'; remove.className = 'delete-button'; remove.dataset.deleteControl = ''; remove.dataset.running = String(detail.batch.running);
    remove.setAttribute('aria-label', `${detail.batch.name} 작업 삭제`);
    remove.addEventListener('click', () => deleteBatch(detail.batch));
    const actions = document.createElement('div'); actions.className = 'review-actions'; actions.append(open, remove);
    title.append(label, actions); heading.append(title);
    const contentRows = [];
    for (const group of groupRows(detail.rows)) {
      const row = body.insertRow(), original = row.insertCell(); row.hidden = true; row.className = 'day-job-row'; contentRows.push(row);
      row.id = `job-${detail.batch.id}-item-${group.id}`;
      original.append(cell(group.originalName, 'original-name'));
      if (group.optionName) original.append(cell(`옵션 · ${group.optionName}`, 'option-name'));
      original.append(cell(`주문 ${group.ids.length}행`, 'source-info'));
      row.insertCell().textContent = group.cleanedName || '미정리';
      row.insertCell().textContent = group.reviewNote;
      row.insertCell().append(cell(labels[group.status], `status ${group.status}`));
    }
    label.setAttribute('aria-controls', contentRows.map(row => row.id).join(' '));
    label.addEventListener('click', () => {
      const expanded = label.getAttribute('aria-expanded') !== 'true';
      label.setAttribute('aria-expanded', String(expanded)); label.textContent = `${expanded ? '▼' : '▶'} ${titleText}`;
      contentRows.forEach(row => { row.hidden = !expanded; });
    });
  }
  $('day-description').textContent = `${$('batch-date').value} · 작업 ${details.length}개 · 주문 ${details.reduce((total, detail) => total + detail.rows.length, 0).toLocaleString()}행`;
  $('day-overview').hidden = false; $('empty-state').hidden = true; $('batch-select').value = 'all';
  updateControls();
}
function selectFiles(next) {
  const invalid = next.filter((file) => !/\.(xlsx|xls)$/i.test(file.name));
  if (invalid.length) { message('.xls 또는 .xlsx 파일을 선택하세요.', true); return; }
  files = next; $('file-list').replaceChildren();
  if (!files.length) $('file-list').textContent = '선택한 파일이 없습니다.';
  else { const count = document.createElement('strong'); count.textContent = `${files.length}개 파일 선택`; $('file-list').append(count, document.createTextNode(files.map((file) => file.name).join(', '))); }
  message(''); updateControls();
}
function canLeave() { return !hasChanges() || window.confirm('저장하지 않은 수정·삭제 내용이 있습니다. 저장하지 않고 이동하시겠습니까?'); }
function deleteItems(targets) {
  if (!current || busy || current.batch.running || !targets.length) return;
  const rowIds = targets.flatMap(group => group.ids);
  if (!window.confirm(`상품명 항목 ${targets.length}개에 연결된 주문 ${rowIds.length}행을 삭제 대상으로 선택하시겠습니까?\n수정 내용 저장을 누르면 삭제가 반영되며, DB의 원본과 검수 기록은 보존됩니다.`)) return;
  rowIds.forEach(id => deletedRowIds.add(id));
  targets.forEach(group => { selected.delete(group.id); drafts.delete(group.id); });
  updateMetrics(); renderRows();
  message(`주문 ${rowIds.length}행을 삭제 대상으로 선택했습니다. 다른 항목의 수정 내용은 유지됩니다. 수정 내용 저장을 눌러 함께 반영하세요.`);
}
async function deleteBatch(batch) {
  if (busy || batch.running) return;
  const unsaved = hasChanges() ? '\n저장하지 않은 수정·항목 삭제 선택은 취소됩니다.' : '';
  if (!window.confirm(`“${batch.name}” 작업의 남은 주문 ${batch.rowCount}행을 모두 삭제하시겠습니까?\n작업 목록과 다운로드에서 즉시 제외되며, 원본과 저장된 검수 기록은 DB에 보존됩니다.${unsaved}`)) return;
  setBusy(true); message('');
  try {
    await api(`/api/batches/${batch.id}`, { method: 'DELETE' });
    clearWorkspace(); await loadHistory(); await showDayOverview();
    message('작업을 삭제했습니다. DB의 원본과 검수 기록은 보존됩니다.');
  } catch (error) { message(error.message, true); } finally { setBusy(false); }
}
$('delete-batch-button').addEventListener('click', () => { if (current) deleteBatch(current.batch); });
$('delete-selected-button').addEventListener('click', () => deleteItems(groups.filter(group => selected.has(group.id))));
function clearWorkspace() {
  current = null; groups = []; selected.clear(); drafts.clear(); deletedRowIds.clear(); visibleLimit = 80;
  $('workspace').hidden = true; $('empty-state').hidden = false;
  $('day-overview').hidden = true; $('day-rows').replaceChildren();
  $('rows').replaceChildren(); $('batch-select').value = '';
  $('search').value = ''; $('status-filter').value = 'all'; $('export-kind').value = 'orders';
  $('select-all').checked = false; $('select-all').indeterminate = false;
  $('files').value = ''; selectFiles([]); updateControls();
  $('progress').textContent = '원본과 옵션을 함께 읽어 상품명을 정리합니다.';
}
$('new-batch-button').addEventListener('click', async () => {
  if (hasChanges()) { message('수정·삭제 내용을 저장한 뒤 새 작업을 시작해 주세요.', true); return; }
  setBusy(true); clearWorkspace(); $('batch-date').value = workDate();
  try { await loadHistory(); message('새 주문 파일을 선택해 주세요. 이전 작업은 날짜를 골라 다시 열 수 있습니다.'); }
  catch (error) { message(error.message, true); } finally { setBusy(false); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('batch-date').addEventListener('change', async () => {
  if (hasChanges()) { $('batch-date').value = workDate(current.batch.createdAt); message('수정·삭제 내용을 저장한 뒤 다른 날짜를 선택해 주세요.', true); return; }
  setBusy(true); clearWorkspace();
  try { await loadHistory(); await showDayOverview(); } catch (error) { message(error.message, true); } finally { setBusy(false); }
});
$('files').addEventListener('change', (event) => selectFiles([...event.target.files]));
for (const event of ['dragenter', 'dragover']) $('dropzone').addEventListener(event, (e) => { e.preventDefault(); if (!busy) $('dropzone').classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) $('dropzone').addEventListener(event, (e) => { e.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').addEventListener('drop', (event) => { if (!busy) selectFiles([...event.dataTransfer.files]); });
$('import-button').addEventListener('click', async () => {
  if (!canLeave()) return;
  const data = new FormData(); files.forEach((file) => data.append('files', file)); setBusy(true); message('파일을 불러오는 중입니다.');
  try {
    const detail = await api('/api/import', { method: 'POST', body: data }); applyDetail(detail); await loadHistory();
    selectFiles([]); $('files').value = ''; message(`파일 ${detail.batch.fileCount}개에서 주문 ${detail.rows.length.toLocaleString()}행을 불러왔습니다.`);
    $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { message(error.message, true); } finally { setBusy(false); }
});
async function openBatch(id) {
  if (!id || !canLeave()) { $('batch-select').value = current ? String(current.batch.id) : ''; return; }
  setBusy(true); message('');
  try { if (id === 'all') await showDayOverview(); else applyDetail(await api(`/api/batches/${id}`)); }
  catch (error) { message(error.message, true); } finally { setBusy(false); }
  if (current?.batch.running) resumeProgress(current.batch.id);
}
$('batch-select').addEventListener('change', () => openBatch($('batch-select').value));
$('normalize-button').addEventListener('click', async () => {
  const id = current.batch.id, rowIds = selected.size ? groups.filter((row) => selected.has(row.id)).flatMap((row) => row.ids) : undefined;
  const initialCount = current.rows.filter((row) => !!row.cleanedName).length;
  setBusy(true, '상품명과 옵션을 읽고 정리하고 있습니다…'); message('');
  let polling = false, active = true;
  const timer = setInterval(async () => {
    if (polling) return; polling = true;
    try { const latest = await api(`/api/batches/${id}`); if (!active) return; updateMetrics(latest); const count = latest.rows.filter((row) => !!row.cleanedName).length - initialCount; $('progress').textContent = `상품명 정리 중… 주문 ${count.toLocaleString()}행에 이름을 반영했습니다.`; } catch {} finally { polling = false; }
  }, 2000);
  try { const detail = await api(`/api/batches/${id}/normalize`, json('POST', { rowIds })); applyDetail(detail); message('상품명 정리가 끝났습니다. 이름과 확인 필요 항목을 검수하세요.'); }
  catch (error) { try { applyDetail(await api(`/api/batches/${id}`)); } catch {} message(error.message, true); }
  finally { active = false; clearInterval(timer); setBusy(false, '이름과 메모를 확인하고 검수 완료를 선택한 뒤 엑셀로 다운로드하세요.'); }
});
$('save-button').addEventListener('click', async () => {
  const changes = [...drafts.values()].flatMap(({ ids, ...change }) => ids.map((id) => ({ id, ...change })));
  setBusy(true); message('');
  try { applyDetail(await api(`/api/batches/${current.batch.id}/rows`, json('PATCH', { changes, deletedRowIds: [...deletedRowIds] }))); await loadHistory(); message('수정·검수·삭제 내용을 저장했습니다.'); }
  catch (error) { message(error.message, true); } finally { setBusy(false); }
});
$('confirm-button').addEventListener('click', () => {
  saveReview(groups.filter(row => selected.has(row.id)));
});
$('select-all').addEventListener('change', () => { filteredGroups().slice(0, visibleLimit).forEach((row) => $('select-all').checked ? selected.add(row.id) : selected.delete(row.id)); renderRows(); });
for (const id of ['search', 'status-filter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { visibleLimit = 80; renderRows(); });
$('show-more').addEventListener('click', () => { visibleLimit += 80; renderRows(); });
async function download(url, options, fallback) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000 * (current?.batch.fileCount || 1));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || data.message || '다운로드를 준비하지 못했습니다.'); }
    const disposition = response.headers.get('content-disposition') || '', encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plain = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
    const filename = encoded ? decodeURIComponent(encoded[1]) : plain ? (plain[1] || plain[2]).trim() : fallback, link = document.createElement('a'), objectUrl = URL.createObjectURL(await response.blob());
    link.href = objectUrl; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('다운로드 준비가 제한 시간 안에 끝나지 않았습니다. 서버 실행 상태를 확인한 뒤 다시 시도해 주세요.');
    throw error;
  } finally { clearTimeout(timeout); }
}
$('export-kind').addEventListener('change', updateControls);
$('export-button').addEventListener('click', async () => {
  const button = $('export-button');
  button.textContent = '다운로드 준비 중…';
  setBusy(true); message('상품명을 교체한 XLSX 파일을 준비하고 있습니다.');
  try { await download(`/api/batches/${current.batch.id}/export?kind=${$('export-kind').value}`, {}, $('export-kind').value === 'names' ? '상품명목록.xlsx' : '정리된주문.xlsx'); message('엑셀 파일을 다운로드했습니다.'); }
  catch (error) { message(error.message, true); } finally { button.textContent = '엑셀 다운로드'; setBusy(false); }
});
$('backup-button').addEventListener('click', async () => {
  setBusy(true); message('');
  try { await download('/api/backup', { method: 'POST' }, 'system0-backup.sqlite'); message('데이터 백업본을 다운로드했습니다. 이 파일을 OneDrive 등에 보관하세요.'); }
  catch (error) { message(error.message, true); } finally { setBusy(false); }
});
window.addEventListener('beforeunload', (event) => { if (hasChanges()) { event.preventDefault(); event.returnValue = ''; } });
async function start() {
  setBusy(true);
  try {
    const status = await api('/api/status'); keyConfigured = status.apiKeyConfigured;
    $('connection-status').textContent = keyConfigured ? 'API 키 등록됨 · 로컬 저장' : 'API 키 미설정';
    await loadHistory(); await showDayOverview();
    if (current?.batch.running) resumeProgress(current.batch.id);
    if (!keyConfigured) message('상품명 정리를 사용하려면 .env의 OPENAI_API_KEY를 설정하고 앱을 다시 실행하세요.', true);
  } catch (error) { message(`서버 연결을 확인하세요. ${error.message}`, true); } finally { setBusy(false); }
}
function resumeProgress(id) {
  $('progress').textContent = '진행 중인 상품명 정리를 불러왔습니다…';
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return; polling = true;
    try {
      const detail = await api(`/api/batches/${id}`);
      if (!detail.batch.running) { clearInterval(timer); applyDetail(detail); $('progress').textContent = '상품명 정리 결과를 검수하세요.'; return; }
      updateMetrics(detail); $('progress').textContent = `상품명 정리 중… 주문 ${detail.rows.filter((row) => row.cleanedName).length.toLocaleString()}행에 이름을 반영했습니다.`;
    } catch (error) { clearInterval(timer); message(`진행 상황을 확인하지 못했습니다. 페이지를 다시 열어 확인하세요. ${error.message}`, true); }
    finally { polling = false; }
  }, 2000);
}
start();
