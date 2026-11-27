'use strict';
const $ = id => document.getElementById(id);
const count = value => Number(value || 0).toLocaleString('ko-KR');
const collectedAt = value => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value));
const paidDate = value => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium' }).format(new Date(value));
const providerNames = { naver: '네이버', coupang: '쿠팡' };
let busy = false, reviewedOrder = null;

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
  if (!response.ok) throw new Error(data.error || '주문을 처리하지 못했습니다.');
  return data;
}

function message(text, error = false) {
  const node = $('intake-message');
  node.textContent = text;
  node.hidden = !text;
  node.classList.toggle('error', error);
}

function setBusy(value, collectLabel = '네이버 주문 가져오기') {
  busy = value;
  $('intake-results').setAttribute('aria-busy', String(value));
  $('collect-button').textContent = collectLabel;
  for (const control of document.querySelectorAll('main button, main input, main select')) control.disabled = value;
}

function orderStatus(order) {
  if (order.state === 'hold') return ['보류', 'attention'];
  if (order.state === 'unverified') return ['주문 상태 미확인', 'attention'];
  if (order.namingStatus === 'pending') return ['상품명 미정리', 'pending'];
  if (order.namingStatus === 'attention' || !order.skuBarcode) return ['확인 필요', 'attention'];
  return order.namingStatus === 'confirmed' ? ['검수 완료', 'confirmed'] : ['정리 완료', 'confirmed'];
}

function render(data) {
  const { summary, orders } = data;
  $('row-count').textContent = `${count(orders.length)}건`;
  const details = [];
  if (data.updatedAt) details.push(`${collectedAt(data.updatedAt)} 수집`, `준비 ${count(summary.quantity)}개`);
  if (data.from && data.to) details.push(`결제 기간 ${paidDate(data.from)}~${paidDate(data.to)}`);
  if (summary.heldCount) details.push(`보류 ${count(summary.heldCount)}건`);
  if (summary.unverifiedCount) details.push(`상태 미확인 ${count(summary.unverifiedCount)}건`);
  $('intake-summary').textContent = details.join(' · ');
  $('retry-button').hidden = !summary.pendingCount;
  const rows = document.createDocumentFragment();
  for (const order of orders) {
    const row = document.createElement('tr');
    const provider = order.provider || data.provider;
    row.insertCell().append(element('strong', providerNames[provider] || provider || '—'), element('small', order.productOrderId));
    const original = row.insertCell();
    original.textContent = order.productName || order.originalName;
    if (order.optionName) original.append(element('small', order.optionName));
    const cleaned = row.insertCell();
    cleaned.textContent = order.cleanedName || '—';
    cleaned.append(element('small', order.skuBarcode || '바코드 없음', 'sku-barcode'));
    row.insertCell().textContent = `${count(order.quantity)}개`;
    const [label, state] = orderStatus(order);
    const status = row.insertCell();
    status.append(element('span', label, `status ${state}`));
    if (order.namingNote) status.append(element('small', order.namingNote));
    const review = element('button', '검수', 'intake-edit');
    review.type = 'button'; review.disabled = busy;
    review.setAttribute('aria-label', `${order.productOrderId} 상품주문 검수`);
    review.addEventListener('click', () => openReview(order));
    status.append(review);
    rows.append(row);
  }
  $('intake-rows').replaceChildren(rows);
  $('intake-table-wrap').hidden = !orders.length;
  $('intake-empty').hidden = Boolean(orders.length);
  $('intake-empty').textContent = data.updatedAt ? '발주 미확인 주문이 없습니다.' : '아직 수집한 주문이 없습니다.';
}

async function loadOrders() {
  setBusy(true);
  try { render(await api('/api/order-intake')); }
  catch (error) { $('intake-empty').textContent = '수집한 주문을 불러오지 못했습니다.'; message(error.message, true); }
  finally { setBusy(false); }
}

async function runIntake(action) {
  if (busy) return;
  const collecting = action === 'collect';
  setBusy(true, collecting ? '주문 수집 중…' : '네이버 주문 가져오기');
  message(collecting ? '주문을 가져오고 상품명을 정리하고 있습니다.' : '미정리 상품명을 정리하고 있습니다.');
  try {
    const data = await api(`/api/order-intake/${action}`, collecting ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookbackDays: Number($('collection-range').value) }),
    } : { method: 'POST' });
    render(data);
    const result = data.collection;
    const summary = result
      ? [`새 주문 ${count(result.added)}건`, `변경 ${count(result.updated)}건`, `기존 ${count(result.unchanged)}건`,
        result.unverified ? `상태 미확인 ${count(result.unverified)}건` : ''].filter(Boolean).join(' · ')
      : '상품명 정리를 마쳤습니다.';
    message(data.namingError ? `${collecting ? summary : ''} ${data.namingError}`.trim() : summary, Boolean(data.namingError));
  } catch (error) {
    message(error.name === 'TimeoutError' ? '작업이 지연되고 있습니다. 잠시 뒤 화면을 새로고침해 결과를 확인해 주세요.' : error.message, true);
  } finally { setBusy(false); }
}

async function openReview(order) {
  if (busy) return;
  setBusy(true);
  message('');
  try {
    const { products } = await api('/api/products');
    reviewedOrder = order;
    $('review-original').textContent = [order.productName || order.originalName, order.optionName, order.productOrderId].filter(Boolean).join(' · ');
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
    render(data);
    $('order-review').close();
    message('검수 내용을 저장했습니다.');
  } catch (error) { $('review-error').textContent = error.message; $('review-error').hidden = false; }
  finally { setBusy(false); }
}

$('collect-button').addEventListener('click', () => runIntake('collect'));
$('retry-button').addEventListener('click', () => runIntake('normalize'));
$('review-form').addEventListener('submit', saveReview);
$('close-review').addEventListener('click', () => $('order-review').close());
$('order-review').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
loadOrders();
