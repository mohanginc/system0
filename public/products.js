'use strict';
const $ = id => document.getElementById(id);
let products = [], unmatched = [], visibleLimit = 50, busy = false;
let costDetail;
const selections = new Map();
const count = value => Number(value || 0).toLocaleString('ko-KR');
const amount = value => value == null ? '미등록' : `${count(value)}원`;

function message(text, error = false) {
  const node = $('message'); node.setAttribute('role', error ? 'alert' : 'status');
  node.setAttribute('aria-live', error ? 'assertive' : 'polite');
  node.textContent = text; node.hidden = !text; node.classList.toggle('error', error);
}
function setBusy(value) {
  busy = value; document.querySelector('main').setAttribute('aria-busy', String(value));
  for (const control of document.querySelectorAll('main button, main input, main select')) control.disabled = value;
  for (const row of $('unmatched-rows').rows) row.querySelector('button').disabled = value || !row.querySelector('select').value;
}
async function api(route, options = {}) {
  const response = await fetch(route, { cache: 'no-store', signal: AbortSignal.timeout(30000), ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '상품·바코드를 처리하지 못했습니다.');
  return data;
}
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sortedProducts = () => [...products].sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.barcode.localeCompare(b.barcode));
const costApi = barcode => `/api/products/${barcode}/costs`;

function renderProducts() {
  const fragment = document.createDocumentFragment();
  for (const product of sortedProducts()) {
    const row = document.createElement('tr');
    for (const value of [product.barcode, product.name, count(product.aliasCount), amount(product.unitCostKrw)]) row.insertCell().textContent = value;
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = '원가 관리'; button.disabled = busy; button.dataset.barcode = product.barcode;
    button.setAttribute('aria-label', `${product.name} 원가 관리`);
    button.addEventListener('click', () => openCost(product.barcode));
    row.insertCell().append(button);
    fragment.append(row);
  }
  $('product-rows').replaceChildren(fragment); $('product-count').textContent = `${count(products.length)}개`;
  $('products-empty').hidden = Boolean(products.length);
}
function renderUnmatched() {
  const query = $('unmatched-search').value.trim().toLocaleLowerCase();
  const filtered = unmatched.filter(item => item.name.toLocaleLowerCase().includes(query));
  const visible = filtered.slice(0, visibleLimit), fragment = document.createDocumentFragment(), options = sortedProducts();
  for (const item of visible) {
    const row = document.createElement('tr'); row.insertCell().textContent = item.name; row.insertCell().textContent = count(item.rowCount);
    const select = document.createElement('select'); select.setAttribute('aria-label', `${item.name}에 연결할 상품`);
    select.add(new Option('상품 선택', ''));
    for (const product of options) select.add(new Option(`${product.barcode} · ${product.name}`, product.barcode));
    select.value = selections.get(item.name) || ''; select.disabled = busy;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'link-button'; button.textContent = '연결';
    button.setAttribute('aria-label', `${item.name} 바코드 연결`); button.disabled = busy || !select.value;
    select.addEventListener('change', () => { selections.set(item.name, select.value); button.disabled = busy || !select.value; });
    button.addEventListener('click', () => linkName(item.name, select.value));
    row.insertCell().append(select); row.insertCell().append(button); fragment.append(row);
  }
  $('unmatched-rows').replaceChildren(fragment); $('unmatched-count').textContent = `${count(unmatched.length)}개`;
  $('visible-count').textContent = `${count(filtered.length)}개 중 ${count(visible.length)}개 표시`;
  $('show-more').hidden = visible.length >= filtered.length; $('show-more').disabled = busy;
  $('unmatched-empty').hidden = Boolean(filtered.length);
  $('unmatched-empty').textContent = query ? '검색 결과가 없습니다.' : '바코드 없는 제품명이 없습니다.';
}
function render() { renderProducts(); renderUnmatched(); }
async function loadProducts() {
  const data = await api('/api/products'); products = data.products; unmatched = data.unmatched;
  const barcodes = new Set(products.map(product => product.barcode)), names = new Set(unmatched.map(item => item.name));
  for (const [name, barcode] of selections) if (!names.has(name) || !barcodes.has(barcode)) selections.delete(name);
  render();
}
async function refresh() {
  if (busy) return; setBusy(true); message('');
  try { await loadProducts(); }
  catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
async function registerProduct(event) {
  event.preventDefault(); if (busy || !$('product-form').reportValidity()) return;
  const name = $('product-name').value.trim(), barcode = $('product-barcode').value.trim();
  if (!name || !/^[0-9]{13}$/.test(barcode)) { message('제품명과 13자리 바코드를 입력하세요.', true); return; }
  setBusy(true); message('');
  try {
    const data = await api('/api/products', post({ barcode, name }));
    products = [...products.filter(product => product.barcode !== data.product.barcode), data.product];
    $('product-form').reset(); render(); message('상품을 등록했습니다.');
  } catch (error) { message(error.message, true); }
  finally { setBusy(false); }
}
async function linkName(name, barcode) {
  if (busy || !barcode) return; setBusy(true); message(''); let linked = false;
  try {
    const data = await api('/api/products/aliases', post({ name, barcode })); linked = true;
    unmatched = unmatched.filter(item => item.name !== name); selections.delete(name); renderUnmatched();
    await loadProducts(); message(`바코드를 연결했습니다. 주문 ${count(data.linkedRows)}행 반영`);
  } catch (error) {
    message(linked ? `바코드는 연결했지만 목록을 갱신하지 못했습니다. 새로고침해 주세요. ${error.message}` : error.message, true);
  } finally { setBusy(false); }
}

function costMessage(text, error = false) {
  const node = $('cost-message');
  node.setAttribute('role', error ? 'alert' : 'status');
  node.classList.toggle('error', error);
  node.textContent = text; node.hidden = !text;
}
function renderCosts() {
  $('cost-rows').replaceChildren();
  for (const { effectiveDate, unitCostKrw } of costDetail.costs) {
    const row = $('cost-rows').insertRow();
    row.insertCell().textContent = effectiveDate;
    row.insertCell().textContent = amount(unitCostKrw);
  }
  $('cost-empty').hidden = Boolean(costDetail.costs.length);
}
async function openCost(barcode) {
  if (busy) return;
  setBusy(true); message('');
  try {
    costDetail = await api(costApi(barcode));
  } catch (error) {
    message(error.message, true);
    return;
  } finally { setBusy(false); }
  $('cost-product').textContent = `${costDetail.product.name} · ${barcode}`;
  $('cost-date').value = costDetail.today;
  $('cost-value').value = '';
  costMessage(''); renderCosts(); $('cost-dialog').showModal();
}
async function registerCost(event) {
  event.preventDefault(); if (busy || !costDetail) return;
  const { barcode } = costDetail.product;
  setBusy(true); costMessage('');
  try {
    const { cost } = await api(costApi(barcode), post({
      effectiveDate: $('cost-date').value, unitCostKrw: Number($('cost-value').value),
    }));
    costDetail.costs = [cost, ...costDetail.costs.filter(item => item.effectiveDate !== cost.effectiveDate)]
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
    const current = costDetail.costs.find(item => item.effectiveDate <= costDetail.today);
    const product = products.find(item => item.barcode === barcode);
    product.unitCostKrw = current?.unitCostKrw ?? null;
    product.costEffectiveDate = current?.effectiveDate ?? null;
    $('cost-value').value = ''; renderProducts(); renderCosts(); costMessage('원가를 등록했습니다.');
  } catch (error) { costMessage(error.message, true); }
  finally { setBusy(false); $('cost-value').focus(); }
}

$('product-form').addEventListener('submit', registerProduct);
$('cost-form').addEventListener('submit', registerCost);
$('close-cost').addEventListener('click', () => $('cost-dialog').close());
$('cost-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('cost-dialog').addEventListener('close', () => {
  $('product-rows').querySelector(`button[data-barcode="${costDetail.product.barcode}"]`)?.focus();
  costDetail = undefined;
});
$('refresh-button').addEventListener('click', refresh);
$('unmatched-search').addEventListener('input', () => { visibleLimit = 50; renderUnmatched(); });
$('show-more').addEventListener('click', () => { if (!busy) { visibleLimit += 50; renderUnmatched(); } });
refresh();
