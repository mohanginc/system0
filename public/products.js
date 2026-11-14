'use strict';
const $ = id => document.getElementById(id);
let products = [], unmatched = [], visibleLimit = 50, busy = false;
const selections = new Map();
const count = value => Number(value || 0).toLocaleString('ko-KR');

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

function renderProducts() {
  const fragment = document.createDocumentFragment();
  for (const product of sortedProducts()) {
    const row = document.createElement('tr');
    for (const value of [product.barcode, product.name, count(product.aliasCount)]) row.insertCell().textContent = value;
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
$('product-form').addEventListener('submit', registerProduct);
$('refresh-button').addEventListener('click', refresh);
$('unmatched-search').addEventListener('input', () => { visibleLimit = 50; renderUnmatched(); });
$('show-more').addEventListener('click', () => { if (!busy) { visibleLimit += 50; renderUnmatched(); } });
refresh();
