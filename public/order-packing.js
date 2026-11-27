'use strict';
const $ = id => document.getElementById(id);
const count = value => Number(value || 0).toLocaleString('ko-KR');
const endpoint = '/api/order-intake/packing';
let packing = null, busy = false, draftBoxes = [];
const releasedBoxes = new Set(), selectedItems = new Map();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function message(text, error = false) {
  const node = $('pack-message');
  node.setAttribute('role', error ? 'alert' : 'status');
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle('error', error);
}

async function api(changes) {
  const options = changes ? { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes) } : {};
  const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(30000), ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '포장 작업을 처리하지 못했습니다.'), { status: response.status });
  return data;
}

function hasChanges() { return Boolean(releasedBoxes.size || draftBoxes.length); }

function syncControls() {
  $('packing').setAttribute('aria-busy', String(busy));
  $('reload-packing').disabled = busy || hasChanges();
  for (const id of ['pick-controls', 'saved-controls', 'preview-controls']) $(id).disabled = busy || !packing;
  $('add-box').disabled = !selectedItems.size;
}

function countsByOrder(boxes) {
  const quantities = new Map();
  for (const box of boxes) {
    for (const { orderItemId, quantity } of box.items) {
      quantities.set(orderItemId, (quantities.get(orderItemId) || 0) + quantity);
    }
  }
  return quantities;
}

function remainingQuantities() {
  const released = countsByOrder(packing.boxes.filter(box => releasedBoxes.has(box.id)));
  const drafted = countsByOrder(draftBoxes);
  return new Map(packing.orders.map(order => {
    const retained = order.allocatedQuantity - (released.get(order.id) || 0);
    const available = order.state === 'pending' ? Math.max(0, order.quantity - retained) : 0;
    return [order.id, available - (drafted.get(order.id) || 0)];
  }));
}

const productLabel = order => order.cleanedName || order.productName || '상품명 미정리';

function renderOrders(remaining) {
  const rows = document.createDocumentFragment();
  let total = 0;
  for (const order of packing.orders) {
    const available = remaining.get(order.id);
    if (available <= 0) { selectedItems.delete(order.id); continue; }
    total += available;
    const row = element('li', undefined, 'pack-order');
    const check = element('input'); check.type = 'checkbox';
    check.id = `pick-${order.id}`;
    const line = element('label', undefined, 'pack-line');
    line.htmlFor = check.id;
    line.append(element('strong', productLabel(order)));
    if (order.optionName) line.append(element('small', order.optionName));
    const details = [order.recipient || '수취인 미확인', order.productOrderId, `배정 가능 ${count(available)}개`];
    if (!order.destinationReady) details.push('배송지 확인 필요');
    line.append(element('small', details.join(' · ')));
    const quantityLabel = element('label', '담을 수량', 'pack-quantity');
    const quantity = element('input'); quantity.type = 'number'; quantity.inputMode = 'numeric';
    quantity.min = '1'; quantity.max = String(available); quantity.step = '1'; quantity.required = true;
    check.checked = selectedItems.has(order.id);
    quantity.disabled = !check.checked;
    const selected = selectedItems.get(order.id);
    if (selected > available) selectedItems.set(order.id, available);
    quantity.value = String(selectedItems.get(order.id) ?? available);
    check.addEventListener('change', () => {
      quantity.disabled = !check.checked;
      if (check.checked) selectedItems.set(order.id, Number(quantity.value));
      else selectedItems.delete(order.id);
      syncControls();
    });
    quantity.addEventListener('input', () => selectedItems.set(order.id, Number(quantity.value)));
    quantityLabel.append(quantity);
    row.append(check, line, quantityLabel); rows.append(row);
  }
  $('available-orders').replaceChildren(rows);
  $('available-count').textContent = `${count(total)}개`;
  $('available-empty').hidden = total > 0;
  $('available-empty').textContent = '지금 포장할 상품이 없습니다.';
  return total;
}

function boxRow(box, title, orderById) {
  const row = element('li', undefined, 'pack-box'), body = element('div', undefined, 'pack-box-body');
  const items = element('ul', undefined, 'pack-box-items'), recipients = new Set();
  let total = 0;
  for (const item of box.items) {
    const order = orderById.get(item.orderItemId);
    const line = element('li', `${order ? productLabel(order) : '상품주문 확인 필요'} · ${count(item.quantity)}개`);
    if (order) {
      recipients.add(order.recipient || '수취인 미확인');
      line.append(element('small', order.productOrderId, 'pack-box-meta'));
    }
    items.append(line); total += item.quantity;
  }
  body.append(element('strong', `${title} · ${count(total)}개`));
  if (box.needsReview) body.append(element('span', '확인 필요', 'pack-box-review'));
  if (recipients.size) body.append(element('small', [...recipients].join(' · '), 'pack-box-meta'));
  body.append(items); row.append(body);
  return row;
}

function renderBoxes(orderById) {
  const saved = document.createDocumentFragment();
  for (const box of packing.boxes) {
    const released = releasedBoxes.has(box.id), row = boxRow(box, `상자 ${box.id}`, orderById);
    row.classList.toggle('is-released', released);
    if (released) row.querySelector('.pack-box-body').append(element('small', '풀기 예정', 'pack-box-meta'));
    const button = element('button', released ? '풀기 취소' : '다시 포장');
    button.type = 'button'; button.dataset.box = String(box.id);
    button.setAttribute('aria-label', `상자 ${box.id} ${button.textContent}`);
    button.addEventListener('click', () => toggleRelease(box.id));
    row.append(button); saved.append(row);
  }
  $('saved-boxes').replaceChildren(saved);
  $('saved-count').textContent = `${count(packing.boxes.length)}개`;
  $('saved-empty').hidden = Boolean(packing.boxes.length);
  $('saved-empty').textContent = '저장한 상자가 없습니다.';
}

function renderPreview(orderById, unallocated) {
  $('packing-preview').hidden = !hasChanges();
  const changes = [];
  if (releasedBoxes.size) changes.push(`상자 ${count(releasedBoxes.size)}개 풀기`);
  if (draftBoxes.length) changes.push(`상자 ${count(draftBoxes.length)}개 추가`);
  changes.push(`저장 후 미배정 ${count(unallocated)}개`);
  $('preview-summary').textContent = changes.join(' · ');
  $('save-packing').textContent = draftBoxes.length ? '포장 변경 저장' : '상자 풀기 저장';
  const draft = document.createDocumentFragment();
  for (const [index, box] of draftBoxes.entries()) {
    const row = boxRow(box, `새 상자 ${index + 1}`, orderById);
    const button = element('button', '빼기'); button.type = 'button';
    button.setAttribute('aria-label', `새 상자 ${index + 1} 빼기`);
    button.addEventListener('click', () => { draftBoxes.splice(index, 1); render(); });
    row.append(button); draft.append(row);
  }
  $('draft-boxes').replaceChildren(draft);
}

function render() {
  const { boxCount, reviewBoxCount, allocatedQuantity, unallocatedQuantity } = packing.summary;
  const summary = [`저장한 상자 ${count(boxCount)}개`, `배정 ${count(allocatedQuantity)}개`, `미배정 ${count(unallocatedQuantity)}개`];
  if (reviewBoxCount) summary.push(`확인 필요 상자 ${count(reviewBoxCount)}개`);
  $('packing-summary').textContent = summary.join(' · ');
  const orderById = new Map(packing.orders.map(order => [order.id, order]));
  const unallocated = renderOrders(remainingQuantities());
  renderBoxes(orderById); renderPreview(orderById, unallocated); syncControls();
}

function toggleRelease(boxId) {
  if (busy) return;
  const restoring = releasedBoxes.delete(boxId);
  if (restoring) {
    if ([...remainingQuantities().values()].some(value => value < 0)) {
      releasedBoxes.add(boxId);
      message('이 상자의 상품을 담은 새 상자를 먼저 빼 주세요.', true);
      return;
    }
  } else releasedBoxes.add(boxId);
  render(); message(restoring ? '' : `상자 ${boxId}의 상품을 다시 담을 수 있습니다.`);
  $('saved-boxes').querySelector(`[data-box="${boxId}"]`)?.focus();
}

function addBox(event) {
  event.preventDefault();
  if (busy || !selectedItems.size) return;
  const remaining = remainingQuantities();
  const items = [...selectedItems].map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
  if (items.some(({ orderItemId, quantity }) => !Number.isSafeInteger(quantity) || quantity < 1 || quantity > remaining.get(orderItemId))) {
    message('담을 수량이 배정 가능 수량을 넘지 않는지 확인해 주세요.', true);
    return;
  }
  const selected = packing.orders.filter(order => selectedItems.has(order.id));
  if (selected.length > 1 && selected.some(order => !order.destinationReady)) {
    message('배송지 확인이 필요한 주문은 상품주문별로 상자를 만들어 주세요.', true);
    return;
  }
  if (new Set(selected.map(order => order.destinationGroup)).size > 1) {
    message('배송지가 다른 주문은 각각 상자로 만들어 주세요.', true);
    return;
  }
  draftBoxes.push({ items, needsReview: selected.some(order => !order.destinationReady) });
  selectedItems.clear();
  render(); message('새 상자를 미리보기에 추가했습니다.');
}

function discardChanges() {
  releasedBoxes.clear(); selectedItems.clear(); draftBoxes = [];
}

async function loadPacking() {
  if (busy || hasChanges()) return;
  busy = true; syncControls(); message('');
  try { packing = await api(); discardChanges(); render(); }
  catch (error) {
    if (!packing) {
      $('available-empty').textContent = '주문을 불러오지 못했습니다.';
      $('saved-empty').textContent = '상자를 불러오지 못했습니다.';
    }
    message(error.message, true);
  } finally { busy = false; syncControls(); }
}

async function savePacking() {
  if (busy || !hasChanges()) return;
  busy = true; syncControls(); message('포장 변경을 저장하고 있습니다.');
  try {
    packing = await api({ expectedVersion: packing.version, removeBoxIds: [...releasedBoxes],
      boxes: draftBoxes.map(({ items }) => ({ items })) });
    discardChanges(); render(); message('포장 변경을 저장했습니다.');
  } catch (error) {
    message(error.status === 409 ? `${error.message} 변경을 취소하고 목록을 새로고침할 수 있습니다.` : error.message, true);
  } finally { busy = false; syncControls(); }
}

$('pack-form').addEventListener('submit', addBox);
$('reload-packing').addEventListener('click', loadPacking);
$('save-packing').addEventListener('click', savePacking);
$('discard-changes').addEventListener('click', () => { discardChanges(); render(); message('포장 변경을 취소했습니다.'); });
loadPacking();
