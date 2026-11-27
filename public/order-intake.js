import { createPackingEditor, orderNumber } from './order-packing.js';

const $ = id => document.getElementById(id);
const count = value => Number(value || 0).toLocaleString('ko-KR');
const collectedAt = value => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value));
const paidDate = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium' }).format(new Date(value));
const providerNames = { naver: '네이버', coupang: '쿠팡' };
let busy = false, reviewedOrder = null, ordersData = null;
const editor = createPackingEditor({ api, isBusy: () => busy, setBusy, message, renderOrders, reloadOrders: loadOrders });

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
  for (const control of document.querySelectorAll('.intake-heading button, .intake-heading input, .intake-heading select, #retry-button, #order-review button, #order-review input, #order-review select')) {
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
  if (order.state === 'hold') return ['보류', 'attention'];
  if (order.state === 'unverified') return ['주문 상태 미확인', 'attention'];
  if (order.namingStatus === 'pending') return ['상품명 미정리', 'pending'];
  if (!order.skuBarcode) return ['바코드 없음', 'attention'];
  if (order.namingStatus === 'attention') return ['상품명 확인 필요', 'attention'];
  return order.namingStatus === 'confirmed' ? ['검수 완료', 'confirmed'] : ['정리 완료', 'confirmed'];
}

function renderOrders() {
  if (!ordersData) return;
  const { summary, orders, providers, updatedAt, from, to } = ordersData;
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
  for (const order of orders) {
    const row = document.createElement('tr');
    const provider = order.provider || ordersData.provider, number = orderNumber(order);
    const source = row.insertCell(), packingOrder = editor.order(order.id);
    source.append(element('strong', providerNames[provider] || provider || '—'), element('small', number));
    if (packingOrder?.recipient) source.append(element('small', packingOrder.recipient));
    if (packingOrder && !packingOrder.destinationReady) source.append(element('small', '배송지 확인 필요', 'destination-attention'));
    const original = row.insertCell();
    original.textContent = order.productName || order.originalName;
    if (order.optionName) original.append(element('small', order.optionName));
    const cleaned = row.insertCell();
    cleaned.textContent = order.cleanedName || '—';
    if (order.skuBarcode) cleaned.append(element('small', order.skuBarcode, 'sku-barcode'));
    row.insertCell().textContent = `${count(order.quantity)}개`;
    const [label, state] = orderStatus(order);
    const status = row.insertCell();
    status.append(element('span', label, `status ${state}`));
    if (order.namingNote) status.append(element('small', order.namingNote));
    const review = element('button', '검수', 'intake-edit');
    review.type = 'button';
    review.setAttribute('aria-label', `${number} 상품주문 검수`);
    review.addEventListener('click', () => openReview(order));
    status.append(review);
    row.insertCell().append(editor.picker(order.id));
    for (const cell of row.cells) cell.dataset.label = headers[cell.cellIndex].textContent;
    rows.append(row);
  }
  $('intake-rows').replaceChildren(rows);
  $('intake-table').hidden = !orders.length;
  $('intake-empty').hidden = Boolean(orders.length);
  $('intake-empty').textContent = updatedAt ? '처리할 수집 주문이 없습니다.' : '아직 수집한 주문이 없습니다.';
  $('pack-actions').hidden = !orders.length;
}

async function updateOrders(data) {
  ordersData = data;
  try { editor.setState(await api('/api/order-intake/packing')); }
  catch (error) {
    editor.setState(null);
    return `포장 목록을 불러오지 못했습니다. ${error.message}`;
  }
  return '';
}

async function loadOrders() {
  if (!canUpdateOrders()) return;
  setBusy(true);
  message('');
  try {
    const packingError = await updateOrders(await api('/api/order-intake'));
    if (packingError) message(packingError, true);
  }
  catch (error) { $('intake-empty').textContent = '수집한 주문을 불러오지 못했습니다.'; message(error.message, true); }
  finally { setBusy(false); }
}

async function runIntake(action, file) {
  if (!canUpdateOrders()) return;
  const naver = action === 'collect';
  setBusy(true, naver ? '주문 수집 중…' : '네이버 주문 가져오기');
  message(action === 'normalize' ? '미정리 상품명을 정리하고 있습니다.' : '주문을 가져오고 상품명을 정리하고 있습니다.');
  try {
    const options = { method: 'POST' };
    if (naver) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ lookbackDays: Number($('collection-range').value) });
    }
    if (file) { options.body = new FormData(); options.body.append('file', file); }
    const data = await api(`/api/order-intake/${action}`, options);
    const packingError = await updateOrders(data);
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
    const data = await api(`/api/order-intake/orders/${reviewedOrder.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cleanedName, skuBarcode, expected: reviewedOrder.reviewVersion }),
    });
    const packingError = await updateOrders(data);
    $('order-review').close();
    message(`검수 내용을 저장했습니다.${packingError ? ` ${packingError}` : ''}`, Boolean(packingError));
  } catch (error) { $('review-error').textContent = error.message; $('review-error').hidden = false; }
  finally { setBusy(false); }
}

$('collect-button').addEventListener('click', () => runIntake('collect'));
$('coupang-button').addEventListener('click', () => { if (canUpdateOrders()) $('coupang-file').click(); });
$('coupang-file').addEventListener('change', event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (file) runIntake('coupang', file);
});
$('retry-button').addEventListener('click', () => runIntake('normalize'));
$('review-form').addEventListener('submit', saveReview);
$('close-review').addEventListener('click', () => $('order-review').close());
$('order-review').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
loadOrders();
