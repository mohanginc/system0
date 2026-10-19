import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { openDatabase, deleteBatch, deleteRows } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { shippingBoard, shippingDates, neighborhood } from '../lib/shipping.mjs';

// 서버 모듈의 환경 파일 로딩도 운영 설정을 읽지 않도록 격리합니다.
process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), 'system0-shipping-absent-' + randomUUID() + '.env');
process.env.OPENAI_API_KEY = '';
const { createApp } = await import('../server.mjs');
const date = '2026-10-14', stamp = '2026-10-14T01:00:00.000Z';
const file = (data, headings = ['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량']) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headings, ...data]), '출고');
  return { originalname: '격리 주문.xlsx', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
};
const rawRow = (id, name = '수유쿠션', overrides = {}) => {
  const row = { id, name, recipient: '테스트 수취인', phone: '010-1111-2222', address: '서울 강남구 테헤란로 123 (역삼동, 테스트빌딩) 101호', quantity: 1, ...overrides };
  return [row.name, row.id, '몰 주문', row.recipient, row.phone, row.address, row.quantity];
};
function batch(db, data, cleaned = [], createdAt = stamp, headings) {
  const source = file(data, headings);
  const detail = importFiles(db, [source]);
  db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(createdAt, detail.batch.id);
  for (const [index, name] of cleaned.entries()) {
    db.prepare('UPDATE rows SET cleaned_name = ?, status = ? WHERE id = ?').run(name, name ? 'confirmed' : 'pending', detail.rows[index].id);
  }
  return { ...detail, source };
}

test('이름별 출고묶음은 원수량과 관계없이 1원본행=1이며 미정리·원본·DB를 보존한다', () => {
  const db = openDatabase(':memory:');
  try {
    const saved = batch(db, [rawRow('001'), rawRow('002', '묶음 제목', { quantity: 5 }), rawRow('003')], ['정리 쿠션', '정리 쿠션', '']);
    const before = db.prepare('SELECT * FROM rows ORDER BY id').all();
    const raw = db.prepare('SELECT raw_json FROM sheets').get().raw_json;
    const result = shippingBoard(db, date);
    assert.deepEqual(result.summary, { bundleCount: 3, groupCount: 2, unpreparedCount: 1, duplicateCount: 0, conflictCount: 0, missingIdCount: 0 });
    assert.equal(result.groups.find(group => group.name === '정리 쿠션').count, 2);
    assert.equal(result.groups.find(group => group.unprepared).count, 1);
    assert.ok(result.groups.every(group => group.invoiceState === 'unavailable'));
    assert.equal(result.invoiceState, 'unavailable', '검수 완료여도 송장 완료로 판단하지 않습니다.');
    assert.deepEqual(db.prepare('SELECT * FROM rows ORDER BY id').all(), before);
    assert.equal(db.prepare('SELECT raw_json FROM sheets').get().raw_json, raw);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files').get().content).equals(saved.source.buffer));
  } finally { db.close(); }
});

test('같은 날짜의 긴 문자열 출고번호 재업로드는 한 번만 세고 작업 선택은 해당 범위를 사용한다', () => {
  const db = openDatabase(':memory:');
  try {
    const large = '202610141234567890';
    const first = batch(db, [rawRow(large), rawRow('00001')], ['정리 쿠션', '정리 쿠션']);
    batch(db, [rawRow(large), rawRow('00001', '원본', { phone: '01011112222' })], ['정리 쿠션', '정리 쿠션']);
    batch(db, [rawRow(large)], ['다른 날짜 이름'], '2026-10-13T01:00:00.000Z');
    const result = shippingBoard(db, date);
    assert.equal(result.summary.bundleCount, 2);
    assert.equal(result.summary.duplicateCount, 2);
    assert.equal(result.summary.conflictCount, 0);
    assert.deepEqual(result.groups[0].shipments.map(row => row.id), ['order:' + large, 'order:00001']);
    const selected = shippingBoard(db, date, first.batch.id);
    assert.equal(selected.selectedBatchId, first.batch.id);
    assert.equal(selected.batches.length, 2);
    assert.equal(selected.summary.duplicateCount, 0);
    assert.equal(selected.summary.bundleCount, 2);
  } finally { db.close(); }
});

test('중복의 서로 다른 명칭·수취인정보는 확인 필요로 분리하고 빈 이름은 알려진 한 이름을 사용한다', () => {
  const db = openDatabase(':memory:');
  try {
    batch(db, [rawRow('name-conflict'), rawRow('recipient-conflict'), rawRow('prepared-later')], ['원래 쿠션', '원래 쿠션', '']);
    batch(db, [rawRow('name-conflict'), rawRow('recipient-conflict', '원본', { address: '경기 수원시 영통구 다른로 9 (매탄동) 201호' }), rawRow('prepared-later')], ['다른 쿠션', '원래 쿠션', '새 이름']);
    const result = shippingBoard(db, date);
    assert.equal(result.summary.bundleCount, 3);
    assert.equal(result.summary.duplicateCount, 3);
    assert.equal(result.summary.conflictCount, 2);
    assert.equal(result.summary.unpreparedCount, 0);
    const conflicts = result.groups.find(group => group.needsAttention);
    assert.equal(conflicts.count, 2);
    assert.equal(conflicts.name, '중복 충돌 · 확인 필요');
    assert.ok(!result.groups.some(group => ['원래 쿠션', '다른 쿠션'].includes(group.name)));
    const uncertainRecipient = conflicts.shipments.find(row => row.id === 'order:recipient-conflict');
    assert.equal(uncertainRecipient.recipient, '확인 필요');
    assert.equal(uncertainRecipient.phone, '');
    assert.equal(uncertainRecipient.neighborhood, '');
    assert.equal(result.groups.find(group => group.name === '새 이름').count, 1);
    assert.equal(result.issues.filter(issue => issue.kind === 'conflict').length, 2);
  } finally { db.close(); }
});

test('출고번호 없는 행과 정밀도를 잃은 숫자 ID는 원본행별로 세고 중복 확인 불가를 표시한다', () => {
  const db = openDatabase(':memory:');
  try {
    batch(db, [rawRow(''), rawRow(''), rawRow(Number.MAX_SAFE_INTEGER + 1)], ['같은 이름', '같은 이름', '같은 이름']);
    const result = shippingBoard(db, date);
    assert.equal(result.summary.bundleCount, 3);
    assert.equal(result.summary.missingIdCount, 3);
    assert.equal(result.summary.duplicateCount, 0);
    assert.ok(result.groups[0].shipments.every(row => row.id.startsWith('row:')));
    assert.ok(result.issues.some(issue => issue.kind === 'unsafe_id'));
    assert.ok(result.issues.some(issue => issue.kind === 'missing_id'));
    const marketplace = batch(db, [['상품 A', '몰 주문1'], ['상품 B', '몰 주문1']], ['상품 A', '상품 B'], stamp, ['상품명', '주문번호']);
    const selected = shippingBoard(db, date, marketplace.batch.id);
    assert.equal(selected.summary.bundleCount, 2, '네이버 주문번호를 내부 출고번호로 오인해 상품행을 합치지 않습니다.');
    assert.equal(selected.summary.missingIdCount, 2);
  } finally { db.close(); }
});

test('삭제된 작업·원본행은 조회와 중복검증에서 제외하며 활성 작업의 실제 행 수를 반환한다', () => {
  const db = openDatabase(':memory:');
  try {
    const deleted = batch(db, [rawRow('A')], ['삭제 작업']);
    const first = batch(db, [rawRow('A'), rawRow('B')], ['남긴 상품', '삭제 상품']);
    deleteBatch(db, deleted.batch.id);
    deleteRows(db, first.batch.id, [first.rows[1].id]);
    const result = shippingBoard(db, date);
    assert.equal(result.summary.bundleCount, 1);
    assert.equal(result.summary.duplicateCount, 0);
    assert.equal(result.batches.length, 1);
    assert.equal(result.batches[0].rowCount, 1);
    assert.deepEqual(shippingDates(db, '2026-10').days, [{ date, batchCount: 1, invoiceState: 'unavailable' }]);
    deleteRows(db, first.batch.id, [first.rows[0].id]);
    assert.equal(shippingBoard(db, date).summary.bundleCount, 0);
    assert.equal(shippingBoard(db, date).batches[0].rowCount, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM source_files').get().n, 2);
  } finally { db.close(); }
});

test('한국 자정 경계와 월말 경계를 적용하고 실제 날짜·작업 범위만 허용한다', () => {
  const db = openDatabase(':memory:');
  try {
    const before = batch(db, [rawRow('before')], ['이전 날짜'], '2026-10-13T14:59:59.999Z');
    const begin = batch(db, [rawRow('begin')], ['자정'], '2026-10-13T15:00:00.000Z');
    batch(db, [rawRow('end')], ['마지막'], '2026-10-14T14:59:59.999Z');
    batch(db, [rawRow('next')], ['다음'], '2026-10-14T15:00:00.000Z');
    batch(db, [rawRow('oct')], ['10월'], '2026-10-31T14:59:59.999Z');
    batch(db, [rawRow('nov')], ['11월'], '2026-10-31T15:00:00.000Z');
    assert.equal(shippingBoard(db, date).summary.bundleCount, 2);
    assert.equal(shippingBoard(db, date, begin.batch.id).summary.bundleCount, 1);
    assert.throws(() => shippingBoard(db, date, before.batch.id), /날짜에 속한/);
    assert.ok(shippingDates(db, '2026-10').days.some(day => day.date === '2026-10-31'));
    assert.deepEqual(shippingDates(db, '2026-11').days.map(day => day.date), ['2026-11-01']);
    for (const invalid of ['2026-02-30', '2026-13-01', '0000-01-01', '2026-1-1', '', ['2026-10-14']]) {
      assert.throws(() => shippingBoard(db, invalid), /날짜/);
    }
    for (const invalid of ['2026-13', '0000-01', '2026-1', '', ['2026-10']]) assert.throws(() => shippingDates(db, invalid), /달력 월/);
    for (const invalid of ['0', '-1', '1.2', 'x', '9007199254740992']) assert.throws(() => shippingBoard(db, date, invalid), /작업 번호/);
    assert.deepEqual(shippingBoard(db, '2026-02-28').groups, []);
  } finally { db.close(); }
});

test('동네는 명시된 행정구역만 반환하고 도로명·건물·호수·임의 읍면동은 반환하지 않는다', () => {
  const cases = [
    ['서울 강남구 테헤란로 123 (역삼동, 테스트빌딩) 101동 501호', '서울 강남구 역삼동'],
    ['경기 수원시 영통구 봉영로 123 테스트아파트 101동 502호', '경기 수원시 영통구'],
    ['경북 포항시 북구 흥해읍 중성리 123-1', '경북 포항시 북구 흥해읍'],
    ['충남 아산시 배방읍 북수로 100', '충남 아산시 배방읍'],
    ['부산 연제구 거제1동 321 (테스트아파트, 101동)', '부산 연제구 거제1동'],
    ['서울 송파구 올림픽로 300(신천동, 테스트타워) 23층', '서울 송파구 신천동'],
    ['서울 강남구 봉은사로 20 (101동, 관리동) 12호', '서울 강남구'],
    ['테스트건물 101동 12호', ''],
    ['', ''],
  ];
  for (const [address, expected] of cases) assert.equal(neighborhood(address), expected);
  const db = openDatabase(':memory:');
  try {
    batch(db, [rawRow('A')], ['단일 상품']);
    const result = shippingBoard(db, date);
    const shipment = result.groups[0].shipments[0];
    assert.deepEqual(Object.keys(shipment).sort(), ['id', 'recipient', 'phone', 'neighborhood'].sort());
    assert.equal(shipment.neighborhood, '서울 강남구 역삼동');
    const serialized = JSON.stringify(result);
    for (const forbidden of ['테헤란로', '123', '테스트빌딩', '101호', 'raw_json', 'address']) assert.ok(!serialized.includes(forbidden), '주소·원본 정보는 응답에 포함하지 않아야 합니다.');
  } finally { db.close(); }
});

test('실제 레거시 샘플은 합배송 명칭도 제품 개수 대신 출고묶음1로 세고 추가출고도 누락하지 않는다',
  { skip: !existsSync('reference-data/orders/(2)-우리시스템다운로드.xls') }, () => {
  const db = openDatabase(':memory:');
  try {
    const source = { originalname: '(2)-우리시스템다운로드.xls', buffer: readFileSync('reference-data/orders/(2)-우리시스템다운로드.xls') };
    const imported = importFiles(db, [source]);
    db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(stamp, imported.batch.id);
    db.prepare('UPDATE rows SET cleaned_name = ? WHERE id = ?').run('양손프리 새싹 쿠션펌 속통, 전용방수커버', imported.rows[0].id);
    const result = shippingBoard(db, date);
    assert.equal(result.summary.bundleCount, 28);
    assert.equal(result.summary.unpreparedCount, 27);
    assert.equal(result.summary.missingIdCount, 1);
    assert.equal(result.groups.find(group => group.name.includes('전용방수커버')).count, 1);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files').get().content).equals(source.buffer));
    assert.ok(result.groups.flatMap(group => group.shipments).every(shipment => Object.keys(shipment).length === 4));
  } finally { db.close(); }
});

test('두 출고 API는 읽기 전용으로 동작하고 잘못된 날짜·월·작업·외부 주소 요청을 거절한다', async t => {
  const app = createApp({ databasePath: ':memory:', apiKey: '', client: null });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  const db = app.locals.db, first = batch(db, [rawRow('A')], ['출고 상품']);
  const previous = batch(db, [rawRow('B')], ['다른 날짜'], '2026-10-13T01:00:00.000Z');
  const base = 'http://127.0.0.1:' + server.address().port;
  const before = db.prepare('SELECT * FROM rows ORDER BY id').all();
  const board = await fetch(base + '/api/shipping/board?date=' + date + '&batchId=' + first.batch.id);
  assert.equal(board.status, 200);
  const detail = await board.json();
  assert.equal(detail.summary.bundleCount, 1);
  assert.equal(detail.selectedBatchId, first.batch.id);
  assert.equal(detail.invoiceState, 'unavailable');
  const dates = await fetch(base + '/api/shipping/dates?month=2026-10');
  assert.equal(dates.status, 200);
  assert.equal((await dates.json()).days.length, 2);
  for (const url of ['/api/shipping/board?date=2026-02-30', '/api/shipping/board?date=' + date + '&batchId=' + previous.batch.id,
    '/api/shipping/board?date=' + date + '&batchId=999', '/api/shipping/board?date=' + date + '&batchId=wrong',
    '/api/shipping/board?date=' + date + '&date=2026-10-15', '/api/shipping/dates?month=2026-13',
    '/api/shipping/dates?month=2026-10&month=2026-11']) assert.equal((await fetch(base + url)).status, 400);
  const externalStatus = await new Promise((resolve, reject) => {
    httpGet(base + '/api/shipping/board', { headers: { host: 'external.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(externalStatus, 403);
  assert.equal((await fetch(base + '/api/shipping/board')).status, 200);
  assert.equal((await fetch(base + '/api/shipping/dates')).status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM rows ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM llm_calls').get().n, 0);
});
