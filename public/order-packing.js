const $ = id => document.getElementById(id);
const count = value => Number(value || 0).toLocaleString('ko-KR');
const endpoint = '/api/order-intake/packing';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
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

const productLabel = order => order?.cleanedName || order?.productName || '상품명 미정리';
export const orderNumber = order => order.provider === 'coupang' ? order.orderId : order.productOrderId;
const boxQuantity = box => box.items.reduce((sum, item) => sum + item.quantity, 0);

export function createPackingEditor({ api, isBusy, setBusy, message, renderOrders, reloadOrders }) {
  let packing = null, draftBoxes = [], orderById = new Map(), remaining = new Map(), dispatchChoices = [];
  const releasedBoxes = new Set(), selectedItems = new Map();

  function hasChanges() { return Boolean(releasedBoxes.size || draftBoxes.length); }

  function remainingQuantities() {
    const released = countsByOrder(packing.boxes.filter(box => releasedBoxes.has(box.id)));
    const drafted = countsByOrder(draftBoxes);
    return new Map(packing.orders.map(order => {
      const retained = order.allocatedQuantity - (released.get(order.id) || 0);
      const available = order.state === 'pending' ? Math.max(0, order.quantity - retained) : 0;
      return [order.id, available - (drafted.get(order.id) || 0)];
    }));
  }

  function eligibleDispatch() {
    if (!packing) return [];
    const boxes = packing.boxes.filter(box => !box.needsReview).map(box => ({
      boxId: box.id, quantity: boxQuantity(box), title: `상자 ${box.id}`,
      detail: box.items.map(item => `${productLabel(orderById.get(item.orderItemId))} ${count(item.quantity)}개`).join(' · '),
    }));
    const units = packing.orders.filter(order => order.state === 'pending' && order.destinationReady && order.availableQuantity > 0)
      .map(order => ({ orderItemId: order.id, quantity: order.availableQuantity, title: productLabel(order),
        detail: [order.recipient, orderNumber(order)].filter(Boolean).join(' · ') }));
    return [...boxes, ...units];
  }

  function syncControls() {
    const busy = isBusy();
    $('pick-controls').disabled = busy;
    $('reload-packing').disabled = busy || hasChanges();
    for (const id of ['saved-controls', 'preview-controls', 'dispatch-preview']) $(id).disabled = busy || !packing;
    $('add-box').disabled = busy || !selectedItems.size;
    $('open-dispatch').disabled = busy || !eligibleDispatch().length;
    $('confirm-dispatch').disabled = busy || !dispatchChoices.some(choice => choice.checked);
  }

  function picker(orderId) {
    const available = remaining.get(orderId) || 0;
    if (available <= 0) {
      selectedItems.delete(orderId);
      return element('small', packing && orderById.get(orderId)?.allocatedQuantity ? '배정 완료' : '—');
    }
    const control = element('div', undefined, 'pack-picker');
    const order = orderById.get(orderId), check = element('input');
    check.type = 'checkbox'; check.checked = selectedItems.has(orderId);
    check.setAttribute('aria-label', `${orderNumber(order)} 포장 선택`);
    const quantity = element('input'); quantity.type = 'number'; quantity.inputMode = 'numeric';
    quantity.setAttribute('aria-label', `${orderNumber(order)} 담을 수량`);
    quantity.min = '1'; quantity.max = String(available); quantity.step = '1'; quantity.required = true;
    quantity.disabled = !check.checked;
    if (selectedItems.get(orderId) > available) selectedItems.set(orderId, available);
    quantity.value = String(selectedItems.get(orderId) ?? available);
    check.addEventListener('change', () => {
      quantity.disabled = !check.checked;
      if (check.checked) selectedItems.set(orderId, Number(quantity.value));
      else selectedItems.delete(orderId);
      syncControls();
    });
    quantity.addEventListener('input', () => selectedItems.set(orderId, Number(quantity.value)));
    control.append(check, quantity, element('small', `미배정 ${count(available)}개`));
    return control;
  }

  function boxRow(box, title) {
    const row = element('li', undefined, 'pack-box'), body = element('div', undefined, 'pack-box-body');
    const items = element('ul', undefined, 'pack-box-items'), recipients = new Set();
    for (const item of box.items) {
      const order = orderById.get(item.orderItemId);
      const line = element('li', `${productLabel(order)} · ${count(item.quantity)}개`);
      if (order) {
        recipients.add(order.recipient || '수취인 미확인');
        line.append(element('small', orderNumber(order), 'pack-box-meta'));
      }
      items.append(line);
    }
    body.append(element('strong', `${title} · ${count(boxQuantity(box))}개`));
    if (box.needsReview) body.append(element('span', '배송 정보 확인 필요', 'pack-box-review'));
    if (recipients.size) body.append(element('small', [...recipients].join(' · '), 'pack-box-meta'));
    body.append(items); row.append(body);
    return row;
  }

  function renderBoxes() {
    const saved = document.createDocumentFragment();
    for (const box of packing.boxes) {
      const released = releasedBoxes.has(box.id), row = boxRow(box, `상자 ${box.id}`);
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
    $('saved-section').hidden = !packing.boxes.length;
  }

  function renderPreview() {
    $('packing-preview').hidden = !hasChanges();
    const changes = [];
    if (releasedBoxes.size) changes.push(`상자 ${count(releasedBoxes.size)}개 풀기`);
    if (draftBoxes.length) changes.push(`상자 ${count(draftBoxes.length)}개 추가`);
    const unallocated = [...remaining.values()].reduce((sum, value) => sum + Math.max(0, value), 0);
    changes.push(`저장 후 미배정 ${count(unallocated)}개`);
    $('preview-summary').textContent = changes.join(' · ');
    $('save-packing').textContent = draftBoxes.length ? '포장 변경 저장' : '상자 풀기 저장';
    const draft = document.createDocumentFragment();
    for (const [index, box] of draftBoxes.entries()) {
      const row = boxRow(box, `새 상자 ${index + 1}`);
      const button = element('button', '빼기'); button.type = 'button';
      button.setAttribute('aria-label', `새 상자 ${index + 1} 빼기`);
      button.addEventListener('click', () => { draftBoxes.splice(index, 1); render(); });
      row.append(button); draft.append(row);
    }
    $('draft-boxes').replaceChildren(draft);
  }

  function closeDispatch() {
    $('dispatch-preview').hidden = true;
    $('dispatch-actions').hidden = false;
    dispatchChoices = [];
  }

  function render() {
    remaining = packing ? remainingQuantities() : new Map();
    renderOrders();
    $('packing').hidden = !packing || (!packing.boxes.length && !hasChanges());
    $('dispatch-section').hidden = !packing || (!packing.orders.length && !packing.boxes.length);
    closeDispatch();
    if (packing) {
      const { boxCount, reviewBoxCount, allocatedQuantity, unallocatedQuantity } = packing.summary;
      const summary = [`저장한 상자 ${count(boxCount)}개`, `배정 ${count(allocatedQuantity)}개`, `미배정 ${count(unallocatedQuantity)}개`];
      if (reviewBoxCount) summary.push(`확인 필요 상자 ${count(reviewBoxCount)}개`);
      $('packing-summary').textContent = summary.join(' · ');
      $('dispatch-available').textContent = `등록 가능 ${count(eligibleDispatch().length)}상자`;
      renderBoxes(); renderPreview();
    } else $('packing-summary').textContent = '';
    syncControls();
  }

  function toggleRelease(boxId) {
    if (isBusy()) return;
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
    if (isBusy() || !selectedItems.size) return;
    const items = [...selectedItems].map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    if (items.some(({ orderItemId, quantity }) => !Number.isSafeInteger(quantity) || quantity < 1 || quantity > remaining.get(orderItemId))) {
      message('담을 수량을 확인해 주세요.', true);
      return;
    }
    const selected = items.map(item => orderById.get(item.orderItemId));
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

  function setState(data) {
    packing = data; orderById = new Map((data?.orders || []).map(order => [order.id, order]));
    discardChanges(); render();
  }

  async function savePacking() {
    if (isBusy() || !hasChanges()) return;
    setBusy(true); message('포장 변경을 저장하고 있습니다.');
    try {
      const data = await api(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: packing.version, removeBoxIds: [...releasedBoxes],
          boxes: draftBoxes.map(({ items }) => ({ items })) }) });
      setState(data); message('포장 변경을 저장했습니다.');
    } catch (error) {
      message(error.status === 409 ? `${error.message} 변경을 취소하고 목록을 새로고침할 수 있습니다.` : error.message, true);
    } finally { setBusy(false); }
  }

  function renderDispatchCount() {
    const selected = dispatchChoices.filter(choice => choice.checked);
    $('dispatch-selected').textContent = `${count(selected.length)}상자 · 상품 ${count(selected.reduce((sum, item) => sum + item.quantity, 0))}개`;
    syncControls();
  }

  function openDispatch() {
    if (isBusy() || !packing) return;
    if (hasChanges()) { message('포장 변경을 먼저 저장하거나 취소해 주세요.', true); return; }
    dispatchChoices = eligibleDispatch().map(item => ({ ...item, checked: true }));
    if (!dispatchChoices.length) return;
    const fragment = document.createDocumentFragment();
    for (const item of dispatchChoices) {
      const row = element('li', undefined, 'dispatch-choice'), label = element('label');
      const check = element('input'); check.type = 'checkbox'; check.checked = true;
      check.addEventListener('change', () => { item.checked = check.checked; renderDispatchCount(); });
      const summary = element('span', undefined, 'pack-box-body');
      summary.append(element('strong', `${item.title} · ${count(item.quantity)}개`));
      if (item.detail) summary.append(element('small', item.detail, 'pack-box-meta'));
      label.append(check, summary); row.append(label); fragment.append(row);
    }
    $('dispatch-choices').replaceChildren(fragment);
    $('dispatch-actions').hidden = true; $('dispatch-preview').hidden = false;
    renderDispatchCount(); $('dispatch-choices').querySelector('input')?.focus();
  }

  async function registerDispatch() {
    const selected = dispatchChoices.filter(choice => choice.checked);
    if (isBusy() || hasChanges() || !selected.length) return;
    setBusy(true); message('출고 등록 중…');
    try {
      const data = await api('/api/order-intake/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: packing.version, boxIds: selected.flatMap(item => item.boxId ? [item.boxId] : []),
          orderItemIds: selected.flatMap(item => item.orderItemId ? [item.orderItemId] : []) }) });
      window.location.assign(`/shipping-board.html?${new URLSearchParams({ date: data.date })}`);
    } catch (error) {
      message(error.status === 409 ? `${error.message} 목록을 새로고침해 주세요.` : error.message, true);
      setBusy(false);
    }
  }

  $('pack-form').addEventListener('submit', addBox);
  $('reload-packing').addEventListener('click', reloadOrders);
  $('save-packing').addEventListener('click', savePacking);
  $('discard-changes').addEventListener('click', () => { discardChanges(); render(); message('포장 변경을 취소했습니다.'); });
  $('open-dispatch').addEventListener('click', openDispatch);
  $('cancel-dispatch').addEventListener('click', () => { closeDispatch(); syncControls(); $('open-dispatch').focus(); });
  $('confirm-dispatch').addEventListener('click', registerDispatch);
  return { setState, picker, order: id => orderById.get(id), hasChanges, syncControls };
}
