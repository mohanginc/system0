import { createPackingEditor, orderNumber } from './order-packing.js';

const $ = id => document.getElementById(id);
const count = value => Number(value || 0).toLocaleString('ko-KR');
const collectedAt = value => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value));
const paidDate = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium' }).format(new Date(value));
const providerNames = { naver: '네이버', coupang: '쿠팡' };
const deliveryFields = {
  recipient: 'delivery-recipient', phone: 'delivery-phone', baseAddress: 'delivery-base-address',
  detailedAddress: 'delivery-detailed-address', postalCode: 'delivery-postal-code', memo: 'delivery-memo',
};
let busy = false, reviewedOrder = null, editedDelivery = null, ordersData = null, activeSearch = '', dispatchNavigation = false;
const editor = createPackingEditor({ api, isBusy: () => busy, setBusy, message, renderOrders, reloadOrders: () => loadOrders(),
  onDispatch: () => { dispatchNavigation = true; } });

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(route, options = {}) {
  const response = await fetch(route, { cache: 'no-store',
    signal: AbortSignal.timeout(options.method === 'POST' ? 300000 : 30000), ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '주문을 처리하지 못했습니다.'), { status: response.status });
  return data;
}

function message(text, error = false) {
  const node = $('intake-message');
  node.setAttribute('role', error ? 'alert' : 'status');
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle('error', error);
}

function setBusy(value, collectLabel = '네이버 주문 가져오기') {
  busy = value;
  $('intake-results').setAttribute('aria-busy', String(value));
  $('collect-button').textContent = collectLabel;
  for (const control of document.querySelectorAll('.intake-heading button, .intake-heading input, .intake-heading select, #intake-search button, #intake-search input, #retry-button, #order-review button, #order-review input, #order-review select, #order-delivery button, #order-delivery input, #order-delivery textarea, .intake-cancel')) {
    control.disabled = value;
  }
  editor.syncControls();
}

function canUpdateOrders() {
  if (busy) return false;
  if (!editor.hasChanges()) return true;
  message('포장 변경을 먼저 저장하거나 취소해 주세요.', true);
  return false;
}

function orderStatus(order) {
  if (order.canceled) return ['판매채널 취소', 'attention'];
  if (order.state === 'closed') return ['판매채널 처리 완료', 'closed'];
  if (order.dispatchHeld) return ['system0 출고 보류', 'attention'];
  if (order.state === 'hold') return ['판매채널 보류', 'attention'];
  if (order.state === 'unverified') return ['주문 상태 미확인', 'attention'];
  if (order.namingStatus === 'pending') return ['상품명 미정리', 'pending'];
  if (!order.skuBarcode) return ['바코드 없음', 'attention'];
  if (order.namingStatus === 'attention') return ['상품명 확인 필요', 'attention'];
  return order.namingStatus === 'confirmed' ? ['검수 완료', 'confirmed'] : ['정리 완료', 'confirmed'];
}

function ordersByBox(orders, boxes) {
  const allocations = new Map(orders.map(order => [order.id, []]));
  for (const box of boxes) {
    for (const { orderItemId, quantity } of box.items) allocations.get(orderItemId)?.push({ box, quantity });
  }
  for (const order of orders) {
    const assigned = allocations.get(order.id);
    if (!assigned.some(({ box }) => box.dispatched)) continue;
    const allocated = assigned.reduce((sum, { box, quantity }) => sum + (box.dispatched ? 0 : quantity), 0);
    if (order.quantity > allocated) assigned.push({ box: null, quantity: order.quantity - allocated });
  }
  const combined = new Map();
  for (const box of boxes) {
    // 분리배송 테두리와 겹치는 상자는 해당 상자 칸에 합배송을 표시한다.
    if (box.items.length > 1 && box.items.every(item => !allocations.has(item.orderItemId) || allocations.get(item.orderItemId).length === 1)) {
      combined.set(box, []);
    }
  }
  const groups = [];
  for (const order of orders) {
    const assigned = allocations.get(order.id);
    const hasHistory = assigned.some(({ box }) => box?.dispatched);
    if (assigned.length > 1) {
      groups.push(assigned.map(allocation => ({ order, hasHistory, assigned: allocation.box ? [allocation] : [],
        quantity: allocation.quantity, kind: 'split' })));
      continue;
    }
    const group = combined.get(assigned[0]?.box);
    const entry = { order, assigned, hasHistory, quantity: hasHistory ? assigned[0].quantity : undefined };
    if (!group) groups.push([entry]);
    else {
      if (!group.length) groups.push(group);
      group.push({ ...entry, kind: 'combined' });
    }
  }
  return groups.flatMap(group => {
    const firstActive = group.findIndex(({ assigned }) => !assigned[0]?.box.dispatched);
    return group.map((entry, index) => ({ ...entry, first: index === 0, last: index === group.length - 1,
      reviewHere: entry.kind !== 'split' || index === firstActive,
      cancelHere: entry.kind !== 'split' || index === Math.max(0, firstActive) }));
  });
}

function renderOrders() {
  if (!ordersData) return;
  const { summary, orders, providers, updatedAt, from, to, dispatchBoxes = [] } = ordersData;
  $('row-count').textContent = `${count(orders.length)}건`;
  const details = [];
  if (updatedAt) details.push(`최근 수집 ${collectedAt(updatedAt)}`);
  if (from && to) details.push(`네이버 결제 기간 ${paidDate(from)}~${paidDate(to)}`);
  if (providers?.coupang?.updatedAt) details.push(`쿠팡 업로드 ${collectedAt(providers.coupang.updatedAt)}`);
  if (summary.heldCount) details.push(`보류 ${count(summary.heldCount)}건`);
  if (summary.unverifiedCount) details.push(`상태 미확인 ${count(summary.unverifiedCount)}건`);
  $('intake-summary').textContent = details.join(' · ');
  $('retry-button').hidden = !summary.pendingCount;
  const rows = document.createDocumentFragment(), headers = [...$('intake-table').tHead.rows[0].cells];
  const retiredIds = new Set(dispatchBoxes.map(box => box.packingBoxId).filter(id => id != null));
  const historicalBoxes = dispatchBoxes.map(box => ({ ...box, dispatched: true,
    title: box.packingBoxId == null ? `출고 상자 ${box.id}` : `상자 ${box.packingBoxId}` }));
  const boxes = [...historicalBoxes, ...editor.visibleBoxes().filter(box => !retiredIds.has(box.id))];
  for (const { order, assigned, kind, first, last, reviewHere, cancelHere, hasHistory, quantity } of ordersByBox(orders, boxes)) {
    const row = document.createElement('tr');
    if (kind) {
      row.classList.add('pack-group', `pack-group-${kind}`);
      if (first) row.classList.add('pack-group-start');
      if (last) row.classList.add('pack-group-end');
    }
    const split = kind === 'split';
    const box = assigned[0]?.box;
    const registered = order.registeredQuantity > 0;
    const dispatched = Boolean(box?.dispatched || (!hasHistory && registered && order.quantity === 0));
    const provider = order.provider || ordersData.provider, number = orderNumber(order);
    const source = row.insertCell(), packingOrder = editor.order(order.id);
    const packingCurrent = order.state !== 'pending' || packingOrder?.quantity === order.quantity;
    if (kind && first) source.append(element('span', split ? '분리배송' : '합배송', split ? 'pack-kind pack-kind-split' : 'pack-kind'));
    const meta = element('div', '', 'intake-order-meta');
    meta.append(element('strong', providerNames[provider] || provider || '—'), element('small', number, 'intake-order-number'));
    if (order.workDate) meta.append(element('small', `작업일 ${order.workDate}`));
    source.append(meta);
    const shipping = box?.dispatched ? box.shipping : box?.shipping || order.shipping;
    const recipient = shipping?.recipient || (!box?.dispatched && (order.recipient || packingOrder?.recipient));
    const phone = shipping?.phone;
    const address = [shipping?.baseAddress, shipping?.detailedAddress].filter(Boolean).join(' ');
    if (recipient || phone || address) {
      const delivery = element('div', '', 'intake-delivery-summary');
      if (recipient || phone) {
        const contact = element('div', '', 'intake-delivery-contact');
        if (recipient) contact.append(element('strong', recipient));
        if (phone) contact.append(element('span', phone, 'intake-delivery-phone'));
        delivery.append(contact);
      }
      if (address) delivery.append(element('small', address, 'intake-delivery-address'));
      source.append(delivery);
    }
    const destinationReady = box?.destinationReady ?? packingOrder?.destinationReady;
    if (!dispatched && destinationReady === false) source.append(element('small', '배송지 확인 필요', 'destination-attention'));
    const original = row.insertCell();
    original.classList.add('intake-original-product');
    original.textContent = order.productName || order.originalName;
    if (order.optionName) original.append(element('small', order.optionName));
    const cleaned = row.insertCell();
    cleaned.append(element('strong', order.cleanedName || '—', 'intake-cleaned-product'));
    if (order.skuBarcode) cleaned.append(element('small', order.skuBarcode, 'sku-barcode'));
    const quantityCell = row.insertCell();
    quantityCell.classList.add('intake-quantity');
    quantityCell.textContent = `${count(quantity ?? (dispatched ? order.registeredQuantity : order.quantity))}개`;
    const [label, state] = orderStatus(order);
    const status = row.insertCell();
    const labels = element('div', '', 'intake-statuses');
    if (dispatched || (registered && !hasHistory)) {
      labels.append(element('span', dispatched ? '출고 등록' : '부분 출고 등록', 'status dispatched'));
    }
    if ((!dispatched && !order.manuallyCanceled) || order.canceled) labels.append(element('span', label, `status ${state}`));
    if (order.manuallyCanceled) labels.append(element('span', '수동 취소', 'status manual-canceled'));
    status.append(labels);
    if (registered && !dispatched && reviewHere) status.append(element('small', `등록 ${count(order.registeredQuantity)}개 · 남음 ${count(order.quantity)}개`));
    if (!dispatched && order.namingNote) status.append(element('small', order.namingNote));
    const canReview = reviewHere && !dispatched && packingCurrent && order.state !== 'closed' && !order.manuallyCanceled && order.quantity > 0;
    const canCancel = cancelHere && order.canManuallyCancel;
    if (canReview || canCancel) {
      const actions = element('div', '', 'intake-order-actions');
      if (canReview) {
        const review = element('button', '검수', 'intake-edit');
        review.type = 'button';
        review.setAttribute('aria-label', `${number} 상품주문 검수`);
        review.addEventListener('click', () => openReview(order));
        actions.append(review);
      }
      if (canReview && order.canEditDelivery) {
        const delivery = element('button', split || box?.canEditDelivery ? '주문 배송 정보' : '배송 정보', 'intake-edit');
        delivery.type = 'button';
        delivery.setAttribute('aria-label', `${number} 배송 정보 수정`);
        delivery.addEventListener('click', () => openDelivery(order));
        actions.append(delivery);
      }
      if (canCancel) {
        const action = order.manuallyCanceled ? '취소 되돌리기' : '수동 취소';
        const cancel = element('button', action, 'intake-edit intake-cancel');
        cancel.type = 'button';
        cancel.disabled = busy;
        cancel.setAttribute('aria-label', `${number} ${action}`);
        cancel.addEventListener('click', () => saveCancellation(order));
        actions.append(cancel);
      }
      status.append(actions);
    }
    const packing = row.insertCell();
    if (kind !== 'combined' && assigned.some(({ box }) => box.items.length > 1)) {
      packing.append(element('span', '합배송', 'pack-kind'));
    }
    packing.append(editor.picker(order.id, assigned, { canPick: (!split || last) && !dispatched && packingCurrent
      && order.state !== 'closed' && !order.dispatchHeld && !order.manuallyCanceled }));
    if (box?.hasDeliveryOverride) packing.append(element('small', '상자 배송 정보 별도 지정'));
    if (!dispatched && packingCurrent && !order.manuallyCanceled && box?.canEditDelivery) {
      const delivery = element('button', '상자 배송 정보', 'intake-edit intake-box-edit');
      delivery.type = 'button';
      delivery.setAttribute('aria-label', `${box.title} 배송 정보 수정`);
      delivery.addEventListener('click', () => openDelivery(order, box));
      packing.append(delivery);
    }
    for (const cell of row.cells) cell.dataset.label = headers[cell.cellIndex].textContent;
    rows.append(row);
  }
  $('intake-rows').replaceChildren(rows);
  $('intake-table').hidden = !orders.length;
  $('intake-empty').hidden = Boolean(orders.length);
  $('intake-empty').textContent = activeSearch ? '검색 조건에 맞는 주문이 없습니다.' : '아직 수집한 주문이 없습니다.';
  $('pack-actions').hidden = !orders.length;
}

async function updateOrders(data) {
  ordersData = data;
  try {
    const packing = await api('/api/order-intake/packing');
    const retiredIds = new Set((data.dispatchBoxes || []).map(box => box.packingBoxId));
    if (packing.boxes.some(box => retiredIds.has(box.id))) {
      editor.setState(null);
      return '출고 등록 내역이 갱신되었습니다. 목록을 새로고침해 주세요.';
    }
    editor.setState(packing, data.orders.map(order => order.id));
  } catch (error) {
    editor.setState(null);
    return `포장 목록을 불러오지 못했습니다. ${error.message}`;
  }
  return '';
}

async function refreshOrders(search = activeSearch) {
  const query = new URLSearchParams(search);
  query.set('view', 'management');
  const data = await api(`/api/order-intake?${query}`);
  activeSearch = search;
  $('reset-search').hidden = !search;
  return updateOrders(data);
}

async function refreshAfterWrite(search = activeSearch) {
  try { return await refreshOrders(search); }
  catch (error) { return `목록을 갱신하지 못했습니다. ${error.message}`; }
}

async function loadOrders(search = activeSearch) {
  if (!canUpdateOrders()) return;
  setBusy(true);
  message('');
  try {
    const packingError = await refreshOrders(search);
    if (packingError) message(packingError, true);
  }
  catch (error) { $('intake-empty').textContent = '수집한 주문을 불러오지 못했습니다.'; message(error.message, true); }
  finally { setBusy(false); }
}

async function runIntake(action, file) {
  if (!canUpdateOrders()) return;
  const naver = action === 'collect';
  const dateInput = $('collection-date');
  if ((naver || file) && !dateInput.reportValidity()) return;
  const workDate = dateInput.value;
  setBusy(true, naver ? '주문 수집 중…' : '네이버 주문 가져오기');
  message(action === 'normalize' ? '미정리 상품명을 정리하고 있습니다.' : '주문을 가져오고 상품명을 정리하고 있습니다.');
  try {
    const options = { method: 'POST' };
    if (naver) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ lookbackDays: Number($('collection-range').value), workDate });
    }
    if (file) { options.body = new FormData(); options.body.append('file', file); options.body.append('workDate', workDate); }
    const data = await api(`/api/order-intake/${action}`, options);
    const packingError = await refreshAfterWrite();
    const result = data.collection;
    const summary = result
      ? [`새 주문 ${count(result.added)}건`, `변경 ${count(result.updated)}건`, `기존 ${count(result.unchanged)}건`,
        result.unverified ? `상태 미확인 ${count(result.unverified)}건` : '',
        result.held ? `보류 ${count(result.held)}건` : ''].filter(Boolean).join(' · ')
      : '상품명 정리를 마쳤습니다.';
    message([result || !data.namingError ? summary : '', data.namingError, packingError].filter(Boolean).join(' '),
      Boolean(data.namingError || packingError));
  } catch (error) {
    message(error.name === 'TimeoutError' ? '작업이 지연되고 있습니다. 잠시 뒤 화면을 새로고침해 결과를 확인해 주세요.' : error.message, true);
  } finally { setBusy(false); }
}

async function openReview(order) {
  if (!canUpdateOrders()) return;
  setBusy(true);
  message('');
  try {
    const { products } = await api('/api/products');
    reviewedOrder = order;
    $('review-original').textContent = [order.productName || order.originalName, order.optionName, orderNumber(order)].filter(Boolean).join(' · ');
    $('review-name').value = order.cleanedName || '';
    const automatic = order.skuBarcode && !order.manualSkuBarcode ? ` · ${order.skuBarcode}` : '';
    $('review-barcode').replaceChildren(new Option(`상품명으로 자동 연결${automatic}`, ''),
      ...products.map(product => new Option(`${product.barcode} · ${product.name}`, product.barcode)));
    $('review-barcode').value = order.manualSkuBarcode || '';
    $('review-error').hidden = true;
  } catch (error) { message(error.message, true); return; }
  finally { setBusy(false); }
  $('order-review').showModal();
}

async function saveReview(event) {
  event.preventDefault();
  if (busy || !reviewedOrder) return;
  const cleanedName = $('review-name').value.trim();
  if (!cleanedName) return;
  const skuBarcode = $('review-barcode').value;
  setBusy(true);
  $('review-error').hidden = true;
  try {
    await api(`/api/order-intake/orders/${reviewedOrder.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanedName, skuBarcode, expected: reviewedOrder.reviewVersion }),
    });
    const packingError = await refreshAfterWrite();
    $('order-review').close();
    message(`검수 내용을 저장했습니다.${packingError ? ` ${packingError}` : ''}`, Boolean(packingError));
  } catch (error) { $('review-error').textContent = error.message; $('review-error').hidden = false; }
  finally { setBusy(false); }
}

function openDelivery(order, box = null) {
  if (!(box ? box.canEditDelivery : order.canEditDelivery) || !canUpdateOrders()) return;
  const shipping = box?.shipping || order.shipping;
  editedDelivery = { order, box, shipping, expectedVersion: editor.version() };
  $('delivery-title').textContent = box ? `${box.title} 배송 정보 수정` : '주문 배송 정보 수정';
  $('delivery-original').textContent = [orderNumber(order), order.cleanedName || order.productName].join(' · ');
  for (const [field, id] of Object.entries(deliveryFields)) $(id).value = shipping?.[field] || '';
  $('delivery-hold-control').hidden = Boolean(box);
  $('delivery-hold').checked = Boolean(order.dispatchHeld);
  $('delivery-error').hidden = true;
  $('order-delivery').showModal();
}

async function saveDelivery(event) {
  event.preventDefault();
  if (busy || !editedDelivery) return;
  const { order: selectedOrder, box, shipping: priorShipping, expectedVersion } = editedDelivery;
  const shipping = {};
  for (const [field, id] of Object.entries(deliveryFields)) {
    const value = $(id).value.trim();
    if ((priorShipping?.[field] || '').trim() !== value) shipping[field] = value;
  }
  const dispatchHeld = $('delivery-hold').checked;
  const shippingChanged = Object.keys(shipping).length > 0;
  const holdChanged = !box && dispatchHeld !== Boolean(selectedOrder.dispatchHeld);
  if (!shippingChanged && !holdChanged) { $('order-delivery').close(); return; }
  setBusy(true);
  $('delivery-error').hidden = true;
  try {
    if (box) {
      const packing = await api(`/api/order-intake/packing/boxes/${box.id}/delivery`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion, shipping }),
      });
      editor.setState(packing);
      $('order-delivery').close();
      message(`${box.title} 배송 정보를 저장했습니다.`);
      return;
    }
    const { order } = await api(`/api/order-intake/orders/${selectedOrder.id}/delivery`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected: selectedOrder.reviewVersion, ...(shippingChanged ? { shipping } : {}), ...(holdChanged ? { dispatchHeld } : {}) }),
    });
    const search = new URLSearchParams(activeSearch);
    const recipientFilter = search.get('recipient');
    if (shipping.recipient && recipientFilter && !order.recipient.normalize('NFC').toLowerCase().includes(recipientFilter.normalize('NFC').toLowerCase())) {
      search.set('recipient', order.recipient);
      $('search-recipient').value = order.recipient;
    }
    const error = await refreshAfterWrite(search.toString());
    $('order-delivery').close();
    message(`주문 변경을 저장했습니다.${error ? ` ${error}` : ''}`, Boolean(error));
  } catch (error) { $('delivery-error').textContent = error.message; $('delivery-error').hidden = false; }
  finally { setBusy(false); }
}

async function saveCancellation(order) {
  if (!order.canManuallyCancel || !canUpdateOrders()) return;
  const canceled = !order.manuallyCanceled;
  setBusy(true);
  message('');
  try {
    const { order: updated } = await api(`/api/order-intake/orders/${order.id}/cancellation`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected: order.reviewVersion, canceled }),
    });
    ordersData.orders = ordersData.orders.map(row => row.id === updated.id ? { ...row, ...updated } : row);
    const error = await refreshAfterWrite();
    if (error) editor.setState(null);
    const result = canceled ? '수동 취소했습니다.' : '수동 취소를 되돌렸습니다.';
    message([result, error].filter(Boolean).join(' '), Boolean(error));
  } catch (error) {
    message(error.status === 409 ? `${error.message} 목록을 새로고침해 주세요.` : error.message, true);
  } finally { setBusy(false); }
}

$('collection-date').value = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
$('intake-search').addEventListener('submit', event => {
  event.preventDefault();
  const search = new URLSearchParams();
  if ($('search-date').value) search.set('workDate', $('search-date').value);
  if ($('search-recipient').value.trim()) search.set('recipient', $('search-recipient').value.trim());
  loadOrders(search.toString());
});
$('reset-search').addEventListener('click', () => {
  if (!canUpdateOrders()) return;
  $('intake-search').reset();
  loadOrders('');
});
$('collect-button').addEventListener('click', () => runIntake('collect'));
$('coupang-button').addEventListener('click', () => { if (canUpdateOrders() && $('collection-date').reportValidity()) $('coupang-file').click(); });
$('coupang-file').addEventListener('change', event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (file) runIntake('coupang', file);
});
$('retry-button').addEventListener('click', () => runIntake('normalize'));
$('review-form').addEventListener('submit', saveReview);
$('close-review').addEventListener('click', () => $('order-review').close());
$('order-review').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('delivery-form').addEventListener('submit', saveDelivery);
$('close-delivery').addEventListener('click', () => $('order-delivery').close());
$('order-delivery').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  if (dispatchNavigation) {
    dispatchNavigation = false;
    setBusy(false);
  }
  loadOrders();
});
loadOrders();
