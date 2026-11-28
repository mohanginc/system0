import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const packingSource = read('order-packing.js').replace(/^export /gm, '');
const intakeSource = read('order-intake.js').replace(/^import .*\n/, '');

class Node {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.classes = new Set();
    this.listeners = {};
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      contains: name => this.classes.has(name),
      toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  set className(value) { this.classes = new Set(value.split(' ')); }
  set textContent(value) { this.text = value ?? ''; this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(' '); }
  get cells() { return this.children; }
  append(...nodes) { this.children.push(...nodes.flatMap(node => node.tagName === 'fragment' ? node.children : [node])); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  insertCell() {
    const cell = new Node('td');
    cell.cellIndex = this.children.length;
    this.append(cell);
    return cell;
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute() {}
  querySelector() { return null; }
}

function render(orders, boxes, { packingOrders = orders, scopeOrderIds, dispatchBoxes = [] } = {}) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Node('div'));
    return nodes.get(id);
  };
  get('intake-table').tHead = { rows: [{ cells: ['채널', '원본', '정리', '수량', '상태', '상자에 담기'].map(textContent => ({ textContent })) }] };
  const context = vm.createContext({ document: { getElementById: get, createElement: tag => new Node(tag), createDocumentFragment: () => new Node('fragment') },
    orders, boxes, packingOrders, scopeOrderIds, dispatchBoxes });
  const end = intakeSource.indexOf('async function updateOrders');
  assert.ok(end > 0);
  vm.runInContext(`const { createPackingEditor, orderNumber } = (() => {
      ${packingSource}
      return { createPackingEditor, orderNumber };
    })();
    function loadOrders() {}
    ${intakeSource.slice(0, end)}
    ordersData = { orders, dispatchBoxes, summary: {} };
    editor.setState({ orders: packingOrders, boxes }, scopeOrderIds);`, context);
  return { rows: get('intake-rows').children, count: get('row-count').textContent, get,
    rerender(nextOrders) {
      context.nextOrders = nextOrders;
      vm.runInContext('ordersData = { ...ordersData, orders: nextOrders }; renderOrders();', context);
      return get('intake-rows').children;
    } };
}

const order = (id, quantity, allocatedQuantity) => ({ id, provider: 'naver', productOrderId: `test-order-${id}`, quantity,
  allocatedQuantity, state: 'pending', destinationReady: true, namingStatus: 'confirmed', skuBarcode: '0000000000000', cleanedName: `상품 ${id}` });
const box = (id, ...items) => ({ id, items: items.map(([orderItemId, quantity]) => ({ orderItemId, quantity })) });
const descendants = (node, predicate) => [node, ...node.children.flatMap(child => descendants(child, predicate))].filter(predicate);
const orderRows = (rows, id) => rows.filter(row => row.cells[0].textContent.includes(`test-order-${id}`));
const badges = rows => rows.flatMap(row => descendants(row, el => el.classList.contains('pack-kind')).map(el => el.textContent));

test('분리배송은 상자별 수량과 그룹을 표시하며 주문 건수나 편집 버튼을 중복시키지 않는다', () => {
  const { rows, count } = render([order(1, 3, 2), order(2, 1, 0), order(3, 1, 1), order(4, 2, 2)],
    [box(4, [1, 1]), box(5, [1, 1]), box(6, [3, 1], [4, 2])]);
  assert.equal(count, '4건');
  assert.equal(rows.length, 5);
  const split = orderRows(rows, 1);
  assert.equal(split.length, 2);
  assert.deepEqual(split.map(row => row.cells[3].textContent), ['1개', '1개']);
  assert.match(split[0].cells[5].textContent, /상자 4 · 1개/);
  assert.match(split[1].cells[5].textContent, /상자 5 · 1개/);
  assert.ok(split.every(row => row.classList.contains('pack-group-split')));
  assert.ok(split[0].classList.contains('pack-group-start'));
  assert.ok(split[1].classList.contains('pack-group-end'));
  assert.deepEqual(badges(split), ['분리배송']);
  assert.deepEqual(split.map(row => descendants(row, el => el.tagName === 'button').length), [1, 0]);
  assert.deepEqual(split.map(row => descendants(row, el => el.type === 'checkbox').length), [0, 1]);
  assert.match(split[1].cells[5].textContent, /미배정 1개/);
  const plain = orderRows(rows, 2);
  assert.equal(plain.length, 1);
  assert.deepEqual(badges(plain), []);
  const combined = [...orderRows(rows, 3), ...orderRows(rows, 4)];
  assert.deepEqual(badges(combined), ['합배송']);
  assert.ok(combined.every(row => row.classList.contains('pack-group') && !row.classList.contains('pack-group-split')));
  assert.ok(combined[0].classList.contains('pack-group-start'));
  assert.ok(combined[1].classList.contains('pack-group-end'));
});

test('분리된 상품이 다른 주문과 상자를 공유하면 해당 상자의 합배송도 표시한다', () => {
  const { rows } = render([order(1, 2, 2), order(2, 1, 1)], [box(4, [1, 1], [2, 1]), box(5, [1, 1])]);
  const split = orderRows(rows, 1);
  assert.deepEqual(badges(split), ['분리배송', '합배송']);
  assert.match(split[0].cells[5].textContent, /합배송/);
  assert.doesNotMatch(split[1].cells[5].textContent, /합배송/);
  assert.deepEqual(badges(orderRows(rows, 2)), ['합배송']);
});

test('출고와 판매채널 취소를 표시하고 부분 출고의 남은 수량만 포장한다', () => {
  const revised = { ...order(1, 0, 0), registeredQuantity: 2, canEditDelivery: false };
  const partial = { ...order(2, 1, 0), registeredQuantity: 1, availableQuantity: 1 };
  const canceled = { ...order(3, 0, 0), state: 'closed', canceled: true };
  const held = { ...order(4, 1, 0), state: 'hold', dispatchHeld: true, canEditDelivery: true };
  const { rows } = render([revised, partial, canceled, held], [], { packingOrders: [partial] });
  assert.match(rows[0].cells[4].textContent, /^출고 등록$/);
  assert.equal(descendants(rows[0], el => el.tagName === 'button' || el.type === 'checkbox').length, 0);
  assert.match(rows[1].cells[4].textContent, /부분 출고 등록.*등록 1개 · 남음 1개/);
  assert.equal(descendants(rows[1], el => el.type === 'checkbox').length, 1);
  assert.match(rows[2].cells[4].textContent, /판매채널 취소/);
  assert.match(rows[3].cells[4].textContent, /system0 출고 보류/);
  assert.equal(descendants(rows[3], el => el.type === 'checkbox').length, 0);
});

test('검색에서 일부만 보이는 상자와 숨겨진 주문은 출고 선택에서 제외한다', () => {
  const first = { ...order(1, 2, 1), availableQuantity: 1 };
  const second = { ...order(2, 1, 1), availableQuantity: 0 };
  const third = { ...order(3, 1, 0), availableQuantity: 1 };
  const { get, rows } = render([first], [box(4, [1, 1], [2, 1])], { packingOrders: [first, second, third], scopeOrderIds: [1] });
  assert.match(rows[0].cells[5].textContent, /상자 4 · 1개/);
  assert.equal(get('saved-section').hidden, true);
  get('open-dispatch').listeners.click();
  assert.equal(get('dispatch-choices').children.length, 1);
  const choice = get('dispatch-choices').children[0].textContent;
  assert.match(choice, /test-order-1/);
  assert.doesNotMatch(choice, /상자 4|test-order-3/);
});

test('목록에서 수취인·연락처·전체 주소를 보고 갱신한 배송 정보를 확인한다', () => {
  const shipping = { recipient: '박수취', phone: '010-0000-1100', baseAddress: '서울시 테스트로 11', detailedAddress: '101호' };
  const boxShipping = { recipient: '최수취', phone: '010-0000-3300', baseAddress: '경기도 테스트로 33', detailedAddress: '303호' };
  const split = { ...order(1, 2, 2), recipient: shipping.recipient, shipping };
  const shipped = { ...order(2, 0, 0), registeredQuantity: 1, recipient: '이수취', shipping: { ...shipping, recipient: '이수취' } };
  const boxes = [{ ...box(4, [1, 1]), canEditDelivery: true },
    { ...box(5, [1, 1]), canEditDelivery: true, hasDeliveryOverride: true, shipping: boxShipping }];
  const { rows, rerender } = render([split, shipped], boxes, { packingOrders: [split] });
  const summaries = rows => rows.flatMap(row => descendants(row.cells[0], el => el.classList.contains('intake-delivery-summary')));
  const [first, second] = orderRows(rows, 1);
  assert.match(summaries([first])[0]?.textContent, /박수취.*010-0000-1100.*서울시 테스트로 11 101호/);
  assert.match(summaries([second])[0]?.textContent, /최수취.*010-0000-3300.*경기도 테스트로 33 303호/);
  assert.match(first.cells[5].textContent, /상자 배송 정보/);
  assert.match(second.cells[5].textContent, /상자 배송 정보 별도 지정/);
  assert.match(summaries(orderRows(rows, 2))[0]?.textContent, /이수취.*서울시 테스트로 11 101호/);

  const updated = { ...shipping, recipient: '김수취', phone: '010-0000-2200', baseAddress: '서울시 테스트길 22', detailedAddress: '202호' };
  const [changed, preserved] = summaries(orderRows(rerender([{ ...split, recipient: updated.recipient, shipping: updated }, shipped]), 1));
  assert.match(changed?.textContent, /김수취.*010-0000-2200.*서울시 테스트길 22 202호/);
  assert.doesNotMatch(changed.textContent, /박수취|010-0000-1100|테스트로 11|101호/);
  assert.match(preserved?.textContent, /최수취.*010-0000-3300.*경기도 테스트로 33 303호/);
});

test('등록한 합배송·분리배송은 읽기 전용으로 남고 부분 출고의 남은 수량만 포장할 수 있다', () => {
  const shipping = { recipient: '현재 수취인', phone: '010-0000-1100', baseAddress: '서울시 가상길 11', detailedAddress: '101호' };
  const shippedShipping = { ...shipping, recipient: '등록 수취인', phone: '010-0000-1200', baseAddress: '성남시 가상길 12' };
  const shared = { ...box(6, [2, 1], [3, 2]), packingBoxId: 13, shipping };
  const first = { ...box(4, [1, 1]), packingBoxId: 11, shipping };
  const second = { ...box(5, [1, 1]), packingBoxId: 12, shipping: shippedShipping, hasDeliveryOverride: true };
  const partial = { ...order(1, 2, 1), registeredQuantity: 2, availableQuantity: 1, canEditDelivery: false, shipping };
  const shipped = [2, 3].map(id => ({ ...order(id, 0, 0), registeredQuantity: id - 1, canEditDelivery: false }));
  const { rows, count, get } = render([partial, ...shipped], [{ ...box(4, [1, 1]), canEditDelivery: true, shipping }],
    { packingOrders: [partial], dispatchBoxes: [first, second, shared] });
  assert.equal(count, '3건');

  const split = orderRows(rows, 1);
  assert.equal(split.length, 4);
  assert.deepEqual(split.map(row => row.cells[3].textContent), ['1개', '1개', '1개', '1개']);
  for (const id of [4, 11, 12]) assert.match(split.map(row => row.cells[5].textContent).join(' '), new RegExp(`상자 ${id} · 1개`));
  assert.ok(badges(split).includes('분리배송'));
  const old = split.filter(row => row.cells[4].textContent === '출고 등록');
  assert.equal(old.length, 2);
  assert.deepEqual(old.map(row => row.cells[3].textContent), ['1개', '1개']);
  const signed = old.find(row => row.cells[0].textContent.includes(shippedShipping.recipient));
  assert.match(signed?.cells[0].textContent, /등록 수취인.*010-0000-1200.*성남시 가상길 12 101호/);
  assert.deepEqual(split.map(row => descendants(row, el => el.type === 'checkbox').length), [0, 0, 0, 1]);
  assert.match(split.at(-1).cells[5].textContent, /미배정 1개/);
  assert.equal(split.flatMap(row => descendants(row, el => el.tagName === 'button' && el.textContent === '상자 배송 정보')).length, 1);

  const combined = [...orderRows(rows, 2), ...orderRows(rows, 3)];
  assert.deepEqual(badges(combined), ['합배송']);
  assert.ok(combined.every(row => row.classList.contains('pack-group-combined')));
  for (const row of [...old, ...combined]) {
    assert.match(row.cells[4].textContent, /^출고 등록$/);
    assert.equal(descendants(row, el => el.tagName === 'button' || el.type === 'checkbox').length, 0);
  }

  get('open-dispatch').listeners.click();
  const candidates = get('dispatch-choices').children;
  assert.equal(candidates.length, 2);
  const candidateLabels = candidates.map(candidate => candidate.textContent).join(' ');
  assert.match(candidateLabels, /상자 4 · 1개/);
  assert.doesNotMatch(candidateLabels, /상자 1[123]/);

  const unpacked = { ...partial, allocatedQuantity: 0, availableQuantity: 2 };
  const unassigned = render([unpacked], [], { dispatchBoxes: [first, second] }).rows;
  assert.equal(unassigned.length, 3);
  const editable = unassigned.filter(row => descendants(row, el => el.type === 'checkbox').length);
  assert.equal(editable.length, 1);
  assert.equal(editable[0].cells[3].textContent, '2개');
  assert.match(editable[0].cells[5].textContent, /미배정 2개/);
});
