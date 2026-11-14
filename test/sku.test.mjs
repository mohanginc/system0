import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { barcodeForName, shipmentType, skuCatalog } from '../lib/sku.mjs';

const normal = '완전밀착 새싹(면100수) D타입 High(13cm)';
const catalog = () => JSON.parse(readFileSync(new URL('../data/sku-catalog.json', import.meta.url), 'utf8'));

test('마스터 35개의 문자열 바코드·체크숫자·원본 근거를 보존하고 회사명 행은 연결하지 않는다', () => {
  const data = catalog();
  assert.equal(data.source.name, 'skuid_babestellar.xls');
  assert.equal(data.source.sha256, 'bd3e2ee2da9d90801ab251b7b7d4c607ffc1329880943d8466e350b65e69b304');
  assert.equal(data.entries.length, 35);
  assert.deepEqual(skuCatalog, data.entries);
  assert.equal(new Set(data.entries.map(entry => entry.barcode)).size, 35);
  for (const entry of data.entries) {
    assert.match(entry.barcode, /^\d{13}$/);
    const sum = [...entry.barcode.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
    assert.equal(Number(entry.barcode[12]), (10 - sum % 10) % 10);
    assert.equal(typeof entry.product, 'string');
    assert.equal(typeof entry.option, 'string');
    assert.ok(Number.isInteger(entry.sourceRow));
  }
  const company = data.entries.find(entry => entry.barcode === '8809538930108');
  assert.equal(company.enabled, false); assert.deepEqual(company.aliases, []);
  assert.equal(barcodeForName(company.product), null);
});

test('검토한 80개 exact 별칭은 모두 22개 지정 SKU로 연결한다', () => {
  const entries = catalog().entries, aliases = entries.flatMap(entry => entry.aliases);
  assert.equal(aliases.length, 80);
  assert.equal(new Set(entries.filter(entry => entry.aliases.length).map(entry => entry.barcode)).size, 22);
  for (const entry of entries) for (const alias of entry.aliases) assert.equal(barcodeForName(alias), entry.barcode, alias);
});

test('공백·대소문자·확인된 선행 업무표식만 정규화한다', () => {
  assert.equal(barcodeForName(normal), '8809538930160');
  assert.equal(barcodeForName(' [ COUPANG ]  완전밀착 새싹 ( 면100수 ) D타입 hIgH ( 13cm ) '), '8809538930160');
  assert.equal(barcodeForName('[쿠팡][주소변경]' + normal), '8809538930160');
  assert.equal(barcodeForName('[미확인상품]' + normal), null);
  assert.equal(barcodeForName(normal + '[쿠팡]'), null);
  assert.equal(barcodeForName('판매용 ' + normal), null);
});

test('정상과 리퍼는 별도 SKU이며 없는 리퍼 SKU를 정상으로 돌리지 않는다', () => {
  assert.equal(barcodeForName(normal + ' 리퍼'), '8809538930207');
  assert.equal(barcodeForName('[맞교환]' + normal + ' 리퍼'), '8809538930207');
  assert.equal(barcodeForName('양손프리 새싹(면100수) 하드 쿠션 Super High(15cm)'), '8809538930252');
  assert.equal(barcodeForName('양손프리 새싹(면100수) 하드 쿠션 Super High(15cm) 리퍼'), '8809538930290');
  assert.equal(barcodeForName('양손프리 새싹(면100수) 하드 쿠션 High(13cm) 리퍼'), null);
  assert.equal(barcodeForName('[리퍼]' + normal), null);
});

test('미등록 구성품·묶음·불확실 상품과 임의 교환문장을 의미 추론으로 강제 연결하지 않는다', () => {
  for (const name of [normal + ' + 방수커버', normal + ' + 손수건 10장', normal + ' 커버', '완전밀착 방수커버 13cm',
    '21도 분유전용 수유쿠션', '휴대용 수유쿠션', normal + ' 2개', '[맞교환]' + normal + ' -> Super High(15cm)', '', null, 8809538930160]) {
    assert.equal(barcodeForName(name), null);
  }
  assert.equal(barcodeForName('[맞교환]완전밀착 새싹(면100수) D타입 Ultra High(17cm)->수퍼하이 15'), '8809538930184');
});

test('맞교환은 같은 제품 SKU로 연결하되 일반 출고와 별도로 구분한다', () => {
  assert.equal(barcodeForName('[ 맞교환 ]' + normal), '8809538930160');
  assert.equal(shipmentType('[ COUPANG ][ 맞교환 ]' + normal), 'exchange');
  assert.equal(shipmentType(normal, '[맞교환]원래 주문 상품명'), 'exchange');
  assert.equal(shipmentType('[주소변경]' + normal, '[쿠팡]원래 상품명'), 'sale');
  assert.equal(shipmentType('일반 상품 (맞교환 설명)'), 'sale');
});
