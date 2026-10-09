import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { unzipSync } from 'fflate';
import { openDatabase, batchDetail, listBatches, deleteBatch, deleteRows } from '../lib/database.mjs';
import { importFiles, parseFiles, splitTitle, exportWorkbook, exportDownload } from '../lib/excel.mjs';
import { normalizeBatch, reviseRows } from '../lib/naming.mjs';
import { createApp } from '../server.mjs';

const file = (data, name = '주문.xlsx') => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), '주문');
  return { originalname: name, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
};
const responseFor = input => ({ output_text: JSON.stringify({ items: input.map(row => ({ id: row.id,
  cleanedName: `정리 ${row.originalName}`, needsAttention: false, note: '' })) }) });
const mockClient = action => ({ responses: { create: action } });
const workbookRows = (buffer, name) => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(workbook.Sheets[name || workbook.SheetNames[0]], { header: 1, defval: null, raw: true, blankrows: true });
};

test('실제 .xls 54개: 주문 1,063행, 중복 헤더·원본 값·순서·출처와 내보내기 보존',
  { skip: !existsSync('reference-data/orders') }, async () => {
  const files = readdirSync('reference-data/orders').filter(name => name.endsWith('.xls')).sort()
    .map(name => ({ originalname: name, buffer: readFileSync(path.join('reference-data/orders', name)) }));
  assert.equal(files.length, 54);
  const parsed = parseFiles(files);
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, files);
    assert.equal(detail.rows.length, 1063);
    assert.equal(detail.batch.fileCount, 54);
    const expectedRows = parsed.flatMap(sheet => sheet.rows.map(row => ({ ...row, sourceFile: sheet.sourceFile, sourceSheet: sheet.sourceSheet })));
    for (const [index, row] of detail.rows.entries()) {
      const expected = expectedRows[index];
      assert.ok(row.originalName === expected.originalName && row.sourceRow === expected.sourceRow
        && row.sourceFile === expected.sourceFile && row.sourceSheet === expected.sourceSheet, '원본 상품·행·파일·시트 출처가 일치해야 합니다.');
    }
    await assert.rejects(exportWorkbook(db, detail.batch.id, 'orders'), /비어 있는 행/);
    reviseRows(db, detail.batch.id, detail.rows.map(row => ({ id: row.id, cleanedName: `검수 제품 ${row.id}`, reviewNote: '', status: 'confirmed' })));
    const savedFiles = db.prepare('SELECT content FROM source_files WHERE batch_id = ? ORDER BY id').all(detail.batch.id);
    for (const [index, source] of files.entries()) assert.ok(Buffer.from(savedFiles[index].content).equals(source.buffer), '원본 바이너리를 그대로 저장해야 합니다.');
    assert.equal(workbookRows(await exportWorkbook(db, detail.batch.id, 'names')).length, 1064);

    const output = await exportDownload(db, detail.batch.id, 'orders');
    assert.equal(output.contentType, 'application/zip');
    const entries = unzipSync(output.buffer);
    assert.equal(Object.keys(entries).length, 54);
    const normalize = value => typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
    for (const source of files) {
      const filename = source.originalname.replace(/\.xls$/i, '_상품명정리.xlsx');
      assert.ok(entries[filename], '원본마다 XLSX 결과가 있어야 합니다.');
      const before = XLSX.read(source.buffer, { type: 'buffer', cellNF: true });
      const after = XLSX.read(entries[filename], { type: 'buffer', cellNF: true });
      assert.deepEqual(after.SheetNames, before.SheetNames);
      for (const sheetName of before.SheetNames) {
        const changed = new Map(detail.rows.filter(row => row.sourceFile === source.originalname && row.sourceSheet === sheetName)
          .map(row => [`F${row.sourceRow}`, `검수 제품 ${row.id}`]));
        const original = before.Sheets[sheetName], actual = after.Sheets[sheetName];
        assert.equal(actual['!ref'], original['!ref']);
        for (const [address, cell] of Object.entries(original).filter(([key]) => !key.startsWith('!'))) {
          assert.equal(normalize(actual[address]?.v), normalize(changed.get(address) ?? cell.v), `${source.originalname} ${address}: 대상 상품명 외 값은 보존해야 합니다.`);
          assert.equal(actual[address]?.t, changed.has(address) ? 's' : cell.t);
          assert.equal(actual[address]?.f, cell.f);
          assert.equal(actual[address]?.z, cell.z);
        }
      }
    }
  } finally { db.close(); }
});

test('가져오기 오류는 전체 취소하고 상품 없는 행을 조용히 누락하지 않는다', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => importFiles(db, [file([['상품명'], ['쿠션']]), file([['상품명', '수량'], ['', 2]], '잘못된.xlsx')]), /2행/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM batches').get().n, 0);
    assert.throws(() => importFiles(db, [file([['주소'], ['회사']])]), /컬럼을 찾을 수/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM rows').get().n, 0);
  } finally { db.close(); }
});

test('제품선택 구분과 실제 옵션 컬럼을 해석 없이 보존한다', () => {
  assert.deepEqual(splitTitle('면20수 스위트하트 / 제품선택: 면100수 새싹 Super High', '15cm'),
    { productName: '면20수 스위트하트', optionName: '면100수 새싹 Super High / 15cm' });
  assert.deepEqual(splitTitle('속통', ''), { productName: '속통', optionName: '' });
});

test('헤더 없는 기존 작업 파일의 B열 직원 명칭과 C열 메모를 보존한다',
  { skip: !existsSync('outputs/orders/제품명_옵션명_연결.xlsx') }, () => {
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [{ originalname: '제품명_옵션명_연결.xlsx', buffer: readFileSync('outputs/orders/제품명_옵션명_연결.xlsx') }]);
    assert.equal(detail.rows.length, 126);
    assert.equal(detail.rows[0].cleanedName, '양손프리 새싹(면100수) 하드 쿠션 Super High(15cm)');
    assert.equal(detail.rows[0].status, 'confirmed');
    assert.equal(detail.rows[0].generatedName, '');
    assert.ok(detail.rows.some(row => row.status === 'pending'));
    assert.ok(detail.rows[0].reviewNote.includes('디자인'));
  } finally { db.close(); }
});

test('동일 한글 파일명 중복 업로드도 ZIP에서 파일별 수정 값과 원본 형식을 보존한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [file([['상품명'], ['쿠션']]), file([['상품명'], ['쿠션']])]);
    reviseRows(db, detail.batch.id, detail.rows.map((row, index) => ({ id: row.id, cleanedName: `제품 ${index}`, reviewNote: '', status: 'confirmed' })));
    const output = await exportDownload(db, detail.batch.id, 'orders');
    assert.equal(output.contentType, 'application/zip');
    const entries = unzipSync(output.buffer);
    assert.deepEqual(Object.keys(entries), ['주문_상품명정리.xlsx', '주문_상품명정리_2.xlsx']);
    for (const [index, content] of Object.values(entries).entries()) assert.deepEqual(workbookRows(content), [['상품명'], [`제품 ${index}`]]);
  } finally { db.close(); }
});

test('고유 이름 내보내기는 중복을 제거하되 원본 다운로드는 빈 행과 중복 행을 보존한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [file([['상품명'], ['쿠션'], [], ['쿠션'], ['쿠션']])]);
    assert.equal(detail.rows.length, 3);
    reviseRows(db, detail.batch.id, detail.rows.map((row, index) => ({ id: row.id, cleanedName: '정리 쿠션',
      reviewNote: index === 2 ? '확인할 소재' : '', status: index === 2 ? 'attention' : 'confirmed' })));
    assert.equal(workbookRows(await exportWorkbook(db, detail.batch.id, 'names')).length, 3);
    assert.deepEqual(workbookRows(await exportWorkbook(db, detail.batch.id, 'orders')), [['상품명'], ['정리 쿠션'], [null], ['정리 쿠션'], ['정리 쿠션']]);
  } finally { db.close(); }
});

test('XLSX 다운로드는 원본 헤더·빈 행·중복 행·수식·보조 시트와 문자열 내용을 보존한다', async () => {
  const workbook = XLSX.utils.book_new();
  const orders = XLSX.utils.aoa_to_sheet([['2026 주문'], ['원상품명', '수량', '비고', '비고'],
    ['기존 쿠션 & <새싹>', 2, '001234', '긴 메모'.repeat(100)], [], ['기존 쿠션 & <새싹>', 1, '마지막']]);
  orders.B3.f = '1+1';
  XLSX.utils.book_append_sheet(workbook, orders, '주문 & 출고');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['직원 안내'], ['기존 쿠션 & <새싹>']]), '안내');
  const original = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', bookSST: true });
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [{ originalname: '원본 주문.xlsx', buffer: original }]);
    assert.equal(detail.rows.length, 2);
    const names = ['새싹(면100수) 쿠션 <하드> & "검수"\n15cm', '직원 수정 이름'];
    reviseRows(db, detail.batch.id, detail.rows.map((row, index) => ({ id: row.id, cleanedName: names[index], reviewNote: '', status: 'confirmed' })));
    const output = await exportDownload(db, detail.batch.id);
    assert.equal(output.filename, '원본 주문_상품명정리.xlsx');
    const after = XLSX.read(output.buffer, { type: 'buffer' });
    assert.deepEqual(after.SheetNames, workbook.SheetNames);
    assert.deepEqual(workbookRows(output.buffer, '주문 & 출고'), [['2026 주문', null, null, null], ['원상품명', '수량', '비고', '비고'], [names[0], 2, '001234', '긴 메모'.repeat(100)], [null, null, null, null], [names[1], 1, '마지막', null]]);
    assert.equal(after.Sheets['주문 & 출고'].B3.f, '1+1');
    assert.deepEqual(workbookRows(output.buffer, '안내'), [['직원 안내'], ['기존 쿠션 & <새싹>']]);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files').get().content).equals(original));
  } finally { db.close(); }
});

test('원본 파일이 없는 이전 작업은 주문 파일을 임의로 재구성하지 않는다', async () => {
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [file([['상품명', '정리된 제품명'], ['쿠션', '정리 쿠션']])]);
    db.prepare('UPDATE sheets SET file_id = NULL WHERE batch_id = ?').run(detail.batch.id);
    await assert.rejects(exportWorkbook(db, detail.batch.id, 'orders'), /원본 파일이 저장되어 있지/);
    assert.equal(workbookRows(await exportWorkbook(db, detail.batch.id, 'names'))[1][1], '정리 쿠션');
  } finally { db.close(); }
});

test('기존 정리 명칭은 명시적인 검수완료가 있어야 확정하며 LLM 초안은 대기로 가져온다', () => {
  const db = openDatabase(':memory:');
  try {
    const regular = importFiles(db, [file([['상품명', '정리된 제품명', '검수상태'],
      ['쿠션 1', '정리 쿠션 1', ''], ['쿠션 2', '정리 쿠션 2', '검수 완료']])]);
    assert.equal(regular.rows[0].status, 'review');
    assert.equal(regular.rows[1].status, 'confirmed');
    const draft = importFiles(db, [file([['원본 쿠션', 'LLM 제목']], '제품명_옵션명_연결_LLM정리.xlsx')]);
    assert.equal(draft.rows[0].status, 'review');
  } finally { db.close(); }
});

test('LLM 입력은 상품/옵션만, 중복 API 호출 제거는 주문 행을 제거하지 않는다', async () => {
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [file([['상품명', '주소', '옵션명'], ['쿠션', '개인주소-A', '새싹'], ['쿠션', '개인주소-B', '새싹'], ['쿠션', '개인주소-C', '하트']])]);
    let calls = 0;
    const client = mockClient(async request => {
      calls++;
      assert.equal(request.store, false);
      assert.equal(request.text.format.strict, true);
      assert.ok(!request.input.includes('개인주소'));
      const input = JSON.parse(request.input);
      assert.equal(input.length, 2);
      assert.deepEqual(Object.keys(input[0]), ['id', 'originalName', 'productName', 'optionName']);
      return responseFor(input);
    });
    const result = await normalizeBatch(db, detail.batch.id, client, 'mock-model');
    assert.equal(calls, 1);
    assert.equal(result.rows.length, 3);
    assert.equal(result.summary.review, 3);
    assert.equal(result.rows[0].cleanedName, result.rows[1].cleanedName);
    assert.equal(result.rows[0].generatedName, result.rows[0].cleanedName);
  } finally { db.close(); }
});

test('LLM 누락·잘못된 ID·거절 응답은 해당 묶음을 저장하지 않는다', async () => {
  const failures = [
    { output_text: '{"items":[]}' },
    { output_text: JSON.stringify({ items: [{ id: 999, cleanedName: '제품', needsAttention: false, note: '' }] }) },
    { output: [{ content: [{ type: 'refusal', refusal: '거절' }] }] },
    { status: 'incomplete', output_text: '{}' },
  ];
  for (const response of failures) {
    const db = openDatabase(':memory:');
    try {
      const detail = importFiles(db, [file([['상품명'], ['쿠션']])]);
      await assert.rejects(normalizeBatch(db, detail.batch.id, mockClient(async () => response), 'mock'));
      assert.equal(batchDetail(db, detail.batch.id).summary.pending, 1);
    } finally { db.close(); }
  }
});

test('부분 API 실패 후 성공한 묶음 유지·미처리만 재시도·직원 수정 이력 보존', async () => {
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [file([['상품명'], ...Array.from({ length: 22 }, (_, i) => [`쿠션 ${i}`])])]);
    let calls = 0;
    await assert.rejects(normalizeBatch(db, detail.batch.id, mockClient(async request => {
      if (++calls === 2) throw { status: 429 };
      return responseFor(JSON.parse(request.input));
    }), 'mock'), /한도 또는 잔액/);
    assert.equal(batchDetail(db, detail.batch.id).summary.review, 20);
    assert.equal(batchDetail(db, detail.batch.id).summary.pending, 2);
    const first = batchDetail(db, detail.batch.id).rows[0];
    reviseRows(db, detail.batch.id, [{ id: first.id, cleanedName: '직원 확정 제목', reviewNote: '소재 수정', status: 'confirmed' }]);
    const result = await normalizeBatch(db, detail.batch.id, mockClient(async request => {
      const input = JSON.parse(request.input);
      assert.equal(input.length, 2);
      return responseFor(input);
    }), 'mock');
    assert.equal(result.rows[0].cleanedName, '직원 확정 제목');
    assert.equal(result.rows[0].generatedName, first.generatedName);
    assert.equal(result.rows[0].reviewNote, '소재 수정');
    assert.equal(result.summary.pending, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM row_revisions').get().n, 1);
    assert.throws(() => reviseRows(db, detail.batch.id, [
      { id: first.id, cleanedName: '잘못 저장되면 안 됨', reviewNote: '', status: 'confirmed' },
      { id: result.rows[1].id, cleanedName: '', reviewNote: '', status: 'confirmed' },
    ]), /비어 있는/);
    assert.equal(batchDetail(db, detail.batch.id).rows[0].cleanedName, '직원 확정 제목');
  } finally { db.close(); }
});

test('작업 날짜 조회는 한국 자정부터 다음 자정 전까지이며 실제 날짜만 허용한다', async t => {
  const app = createApp({ databasePath: ':memory:', client: null });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/batches`;
  const insert = app.locals.db.prepare('INSERT INTO batches (name, file_count, row_count, created_at) VALUES (?, 1, 1, ?)');
  for (const [index, timestamp] of ['2026-10-05T14:59:59.999Z', '2026-10-05T15:00:00.000Z',
    '2026-10-06T14:59:59.999Z', '2026-10-06T15:00:00.000Z'].entries()) insert.run(`작업 ${index}`, timestamp);
  const result = await fetch(`${base}?date=2026-10-06`);
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).batches.map(batch => batch.id), [3, 2]);
  assert.equal((await (await fetch(base)).json()).batches.length, 4);
  for (const date of ['2026-10-04', '2024-02-29']) {
    const empty = await fetch(`${base}?date=${date}`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).batches, []);
  }
  for (const date of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-10-00', '2026-1-6', '', '0000-01-01']) {
    const invalid = await fetch(`${base}?date=${date}`);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /실제 존재하는 날짜/);
  }
  assert.equal((await fetch(`${base}?date=2026-10-06&date=2026-10-07`)).status, 400);
});

test('API: 한글 업로드·선택 변환·진행 중 충돌 방지·외부 요청 차단·백업 복구', async t => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'system0-test-'));
  let release;
  const app = createApp({ databasePath: path.join(temp, 'data.sqlite'), client: mockClient(async request => {
    await new Promise(resolve => { release = resolve; });
    return responseFor(JSON.parse(request.input));
  }), model: 'mock' });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); rmSync(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = new FormData();
  form.append('files', new Blob([file([['상품명'], ['새싹 쿠션']]).buffer]), '한글 주문.xlsx');
  const imported = await (await fetch(`${base}/api/import`, { method: 'POST', body: form })).json();
  assert.equal(imported.rows[0].sourceFile, '한글 주문.xlsx');
  const id = imported.batch.id;
  const rowId = imported.rows[0].id;
  const normalize = fetch(`${base}/api/batches/${id}/normalize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowIds: [rowId] }) });
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  const detail = await (await fetch(`${base}/api/batches/${id}`)).json();
  assert.equal(detail.batch.running, true);
  assert.equal((await fetch(`${base}/api/batches/${id}/rows`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"changes":[]}' })).status, 409);
  assert.equal((await fetch(`${base}/api/batches/${id}/normalize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
  assert.equal((await fetch(`${base}/api/batches/${id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await fetch(`${base}/api/batches/${id}/rows`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowIds: [rowId] }) })).status, 409);
  release();
  assert.equal((await normalize).status, 200);
  const exportResponse = await fetch(`${base}/api/batches/${id}/export`);
  assert.equal(exportResponse.status, 200);
  assert.ok(exportResponse.headers.get('content-disposition').includes(encodeURIComponent('한글 주문_상품명정리.xlsx')));
  assert.deepEqual(workbookRows(Buffer.from(await exportResponse.arrayBuffer())), [['상품명'], ['정리 새싹 쿠션']]);
  assert.equal((await fetch(`${base}/api/import`, { method: 'POST', headers: { Origin: 'https://outside.example' } })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/status`, { headers: { Host: 'outside.example' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  const backupResponse = await fetch(`${base}/api/backup`, { method: 'POST' });
  assert.equal(backupResponse.status, 200);
  const backupPath = path.join(temp, 'restore.sqlite');
  writeFileSync(backupPath, Buffer.from(await backupResponse.arrayBuffer()));
  const restored = openDatabase(backupPath);
  try {
    assert.equal(batchDetail(restored, id).rows[0].cleanedName, '정리 새싹 쿠션');
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.prepare('SELECT count(*) AS n FROM source_files').get().n, 1);
  } finally { restored.close(); }
});

test('기존 DB 마이그레이션과 재시작 후 삭제 표시·원본 파일·전체 행·검수 이력을 보존한다', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-delete-'));
  const filename = path.join(directory, 'legacy.sqlite');
  let db = openDatabase(filename);
  try {
    const first = importFiles(db, [file([['상품명'], ['삭제할 주문'], ['남길 주문']])]);
    const other = importFiles(db, [file([['상품명'], ['다른 작업']])]);
    reviseRows(db, first.batch.id, first.rows.map(row => ({ id: row.id, cleanedName: `직원 ${row.originalName}`, reviewNote: '검수 기록', status: 'confirmed' })));
    const sources = db.prepare('SELECT * FROM source_files ORDER BY id').all();
    const sheets = db.prepare('SELECT * FROM sheets ORDER BY id').all();
    const revisions = db.prepare('SELECT * FROM row_revisions ORDER BY id').all();
    db.exec('ALTER TABLE batches DROP COLUMN is_deleted; ALTER TABLE rows DROP COLUMN is_deleted');
    db.close(); db = null;
    db = openDatabase(filename);
    assert.ok(db.prepare('SELECT is_deleted FROM rows').all().every(row => row.is_deleted === 0));
    assert.ok(db.prepare('SELECT is_deleted FROM batches').all().every(batch => batch.is_deleted === 0));
    assert.equal(batchDetail(db, first.batch.id).rows.length, 2);
    const result = deleteRows(db, first.batch.id, [first.rows[0].id]);
    assert.equal(result.batch.rowCount, 1);
    assert.equal(result.summary.total, 1);
    assert.equal(result.summary.confirmed, 1);
    const allRows = db.prepare('SELECT * FROM rows ORDER BY id').all();
    assert.equal(allRows.length, 3);
    assert.equal(allRows[0].cleaned_name, '직원 삭제할 주문');
    assert.equal(allRows[0].is_deleted, 1);
    assert.deepEqual(deleteBatch(db, first.batch.id), { deleted: true });
    assert.deepEqual(db.prepare('SELECT * FROM rows ORDER BY id').all(), allRows, '작업 삭제는 하위 행을 변경하지 않아야 합니다.');
    db.close(); db = null;
    db = openDatabase(filename);
    assert.equal(batchDetail(db, first.batch.id), null);
    assert.deepEqual(listBatches(db).map(batch => batch.id), [other.batch.id]);
    assert.equal(batchDetail(db, other.batch.id).rows[0].originalName, '다른 작업');
    assert.equal(db.prepare('SELECT is_deleted FROM batches WHERE id = ?').get(first.batch.id).is_deleted, 1);
    assert.deepEqual(db.prepare('SELECT * FROM source_files ORDER BY id').all(), sources);
    assert.deepEqual(db.prepare('SELECT * FROM sheets ORDER BY id').all(), sheets);
    assert.deepEqual(db.prepare('SELECT * FROM row_revisions ORDER BY id').all(), revisions);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('행 삭제는 중복·다른 작업·이미 삭제된 ID 혼입을 원자적으로 거부하고 AI·수정에서 제외한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const first = importFiles(db, [file([['상품명'], ['삭제 주문'], ['남길 주문 1'], ['남길 주문 2']])]);
    const other = importFiles(db, [file([['상품명'], ['다른 주문']])]);
    const removedId = first.rows[0].id, activeId = first.rows[1].id;
    deleteRows(db, first.batch.id, [removedId]);
    for (const rowIds of [[], [activeId, activeId], [activeId, other.rows[0].id], [activeId, removedId], [0], [1.5], [activeId, 999999], 'wrong']) {
      assert.throws(() => deleteRows(db, first.batch.id, rowIds));
      assert.equal(batchDetail(db, first.batch.id).batch.rowCount, 2);
      assert.equal(db.prepare('SELECT is_deleted FROM rows WHERE id = ?').get(activeId).is_deleted, 0);
    }
    await assert.rejects(normalizeBatch(db, first.batch.id, mockClient(async () => assert.fail('삭제행을 AI에 보내면 안 됩니다.')), 'mock', [removedId]), /현재 작업/);
    assert.throws(() => reviseRows(db, first.batch.id, [{ id: removedId, cleanedName: '삭제행 수정', reviewNote: '', status: 'confirmed' }]), /행의 번호/);
    const result = await normalizeBatch(db, first.batch.id, mockClient(async request => {
      const input = JSON.parse(request.input);
      assert.deepEqual(input.map(row => row.id), first.rows.slice(1).map(row => row.id));
      return responseFor(input);
    }), 'mock');
    assert.equal(result.summary.review, 2);
    assert.equal(db.prepare('SELECT generated_name FROM rows WHERE id = ?').get(removedId).generated_name, '');
    assert.equal(batchDetail(db, other.batch.id).summary.pending, 1);
  } finally { db.close(); }
});

test('첫·중간·마지막 중복 주문 삭제 후 남은 값·빈 행·병합·행높이·필터·보조 시트를 보존한다', async () => {
  const workbook = XLSX.utils.book_new();
  const orders = XLSX.utils.aoa_to_sheet([['상품명', '수량', '전화번호', '비고', '비고'],
    ['중복 주문', 1, '01000000001', '삭제 첫행'], ['남길 주문 1', 2, '01000000002', '남김 1'], [],
    ['중복 주문', 3, '01000000003', '삭제 중간'], ['남길 주문 2', 4, '01000000004', '남김 2'],
    ['중복 주문', 5, '01000000005', '삭제 마지막']]);
  orders['!merges'] = [XLSX.utils.decode_range('C6:D6')];
  orders['!rows'] = Array.from({ length: 7 }, (_, index) => ({ hpt: 20 + index }));
  orders['!cols'] = [{ wch: 30 }, { wch: 8 }, { wch: 15 }];
  orders['!autofilter'] = { ref: 'A1:E7' };
  XLSX.utils.book_append_sheet(workbook, orders, '주문');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['직원 안내'], ['원본 메모']]), '안내');
  const original = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [{ originalname: '주문.xlsx', buffer: original }]);
    reviseRows(db, detail.batch.id, detail.rows.map(row => ({ id: row.id, cleanedName: `정리 ${row.originalName}`, reviewNote: '', status: 'confirmed' })));
    const removed = deleteRows(db, detail.batch.id, detail.rows.filter(row => row.originalName === '중복 주문').map(row => row.id));
    assert.equal(removed.batch.rowCount, 2);
    const output = await exportDownload(db, detail.batch.id);
    assert.deepEqual(workbookRows(output.buffer, '주문'), [['상품명', '수량', '전화번호', '비고', '비고'],
      ['정리 남길 주문 1', 2, '01000000002', '남김 1', null], [null, null, null, null, null],
      ['정리 남길 주문 2', 4, '01000000004', '남김 2', null]]);
    const after = XLSX.read(output.buffer, { type: 'buffer', cellStyles: true });
    const sheet = after.Sheets['주문'];
    assert.deepEqual(sheet['!merges'], [XLSX.utils.decode_range('C4:D4')]);
    assert.deepEqual(sheet['!rows'].map(row => row.hpt), [20, 22, 23, 25]);
    assert.equal(sheet['!autofilter'].ref, 'A1:E4');
    assert.equal(sheet['!cols'][0].wch, XLSX.read(original, { type: 'buffer', cellStyles: true }).Sheets['주문']['!cols'][0].wch);
    assert.deepEqual(workbookRows(output.buffer, '안내'), [['직원 안내'], ['원본 메모']]);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files').get().content).equals(original));
    assert.equal(db.prepare('SELECT count(*) AS n FROM rows').get().n, 5);
    assert.equal(workbookRows(await exportWorkbook(db, detail.batch.id, 'names')).length, 3);
  } finally { db.close(); }
});

test('실제 .xls 주문의 첫·중간·마지막 삭제 후 모든 나머지 셀 값·타입·표시형식을 보존한다',
  { skip: !existsSync('reference-data/orders') }, async () => {
  const sourceName = readdirSync('reference-data/orders').filter(name => name.endsWith('.xls')).sort().find(name => {
    const workbook = XLSX.read(readFileSync(path.join('reference-data/orders', name)), { type: 'buffer' });
    return !Object.values(workbook.Sheets).some(sheet => Object.values(sheet).some(cell => cell?.f || cell?.F))
      && parseFiles([{ originalname: name, buffer: readFileSync(path.join('reference-data/orders', name)) }])[0].rows.length >= 5;
  });
  assert.ok(sourceName);
  const original = readFileSync(path.join('reference-data/orders', sourceName));
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [{ originalname: sourceName, buffer: original }]);
    reviseRows(db, detail.batch.id, detail.rows.map(row => ({ id: row.id, cleanedName: `검수 ${row.id}`, reviewNote: '', status: 'confirmed' })));
    const selected = [detail.rows[0], detail.rows[Math.floor(detail.rows.length / 2)], detail.rows.at(-1)];
    const removed = new Set(selected.map(row => row.sourceRow));
    deleteRows(db, detail.batch.id, selected.map(row => row.id));
    const after = XLSX.read(await exportWorkbook(db, detail.batch.id, 'orders'), { type: 'buffer', cellNF: true });
    const before = XLSX.read(original, { type: 'buffer', cellNF: true });
    const normalize = value => typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value;
    const cleaned = new Map(detail.rows.map(row => [`F${row.sourceRow}`, `검수 ${row.id}`]));
    assert.deepEqual(after.SheetNames, before.SheetNames);
    for (const [sheetName, sheet] of Object.entries(before.Sheets)) {
      for (const [address, cell] of Object.entries(sheet).filter(([key]) => !key.startsWith('!'))) {
        const position = XLSX.utils.decode_cell(address), sourceRow = position.r + 1;
        if (removed.has(sourceRow)) continue;
        const target = XLSX.utils.encode_cell({ ...position, r: position.r - [...removed].filter(row => row < sourceRow).length });
        const actual = after.Sheets[sheetName][target];
        assert.equal(normalize(actual?.v), normalize(cleaned.get(address) ?? cell.v), `${address}→${target}: 삭제 대상 외 값은 보존해야 합니다.`);
        assert.equal(actual?.t, cleaned.has(address) ? 's' : cell.t);
        assert.equal(actual?.z, cell.z);
      }
    }
    assert.equal(batchDetail(db, detail.batch.id).summary.total, detail.rows.length - 3);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files').get().content).equals(original));
  } finally { db.close(); }
});

test('완전히 삭제한 파일은 ZIP에서 제외하고 모든 행을 삭제하면 두 다운로드를 거부한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [file([['상품명'], ['삭제 파일']], '첫파일.xlsx'), file([['상품명'], ['남길 파일']], '둘째파일.xlsx')]);
    reviseRows(db, detail.batch.id, detail.rows.map(row => ({ id: row.id, cleanedName: `정리 ${row.originalName}`, reviewNote: '', status: 'confirmed' })));
    deleteRows(db, detail.batch.id, [detail.rows[0].id]);
    const output = await exportDownload(db, detail.batch.id);
    assert.equal(output.contentType, 'application/zip');
    assert.deepEqual(Object.keys(unzipSync(output.buffer)), ['둘째파일_상품명정리.xlsx']);
    assert.deepEqual(workbookRows(Object.values(unzipSync(output.buffer))[0]), [['상품명'], ['정리 남길 파일']]);
    const empty = deleteRows(db, detail.batch.id, [detail.rows[1].id]);
    assert.equal(empty.batch.rowCount, 0);
    assert.equal(empty.batch.fileCount, 2);
    assert.equal(empty.summary.total, 0);
    for (const kind of ['orders', 'names']) await assert.rejects(exportDownload(db, detail.batch.id, kind), /남아 있는 주문 행/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM source_files').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM rows').get().n, 2);
  } finally { db.close(); }
});

test('행 이동 후 참조 없는 상수 산술식과 cached value는 그대로 보존한다', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['상품명', '금액'], ['삭제 주문', 0], ['남길 주문', 11400], ['다음 주문', -14]]);
  sheet.B3.f = '3*3800';
  sheet.B4.f = '(2.5 + 1)*-4';
  XLSX.utils.book_append_sheet(workbook, sheet, '주문');
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [{ originalname: '상수.xlsx', buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) }]);
    reviseRows(db, detail.batch.id, detail.rows.map(row => ({ id: row.id, cleanedName: `정리 ${row.originalName}`, reviewNote: '', status: 'confirmed' })));
    deleteRows(db, detail.batch.id, [detail.rows[0].id]);
    const after = XLSX.read(await exportWorkbook(db, detail.batch.id, 'orders'), { type: 'buffer' }).Sheets['주문'];
    assert.equal(after.B2.f, '3*3800');
    assert.equal(after.B2.v, 11400);
    assert.equal(after.B3.f, '(2.5 + 1)*-4');
    assert.equal(after.B3.v, -14);
  } finally { db.close(); }
});

test('실제 rus00 (14).xls 복사본의 3*3800 수식과 cached value는 추가 주문 삭제 후 보존한다',
  { skip: !existsSync('reference-data/orders/rus00 (14).xls') }, async () => {
  const original = readFileSync('reference-data/orders/rus00 (14).xls');
  const copy = XLSX.read(original, { type: 'buffer' });
  XLSX.utils.sheet_add_aoa(copy.Sheets.rus00, [['삭제할 추가 주문']], { origin: 'F3' });
  const db = openDatabase(':memory:');
  try {
    const detail = importFiles(db, [{ originalname: 'rus00 (14).xlsx', buffer: XLSX.write(copy, { type: 'buffer', bookType: 'xlsx' }) }]);
    assert.ok(detail.rows.length > 1);
    reviseRows(db, detail.batch.id, detail.rows.map(row => ({ id: row.id, cleanedName: `검수 ${row.id}`, reviewNote: '', status: 'confirmed' })));
    deleteRows(db, detail.batch.id, [detail.rows.at(-1).id]);
    const after = XLSX.read(await exportWorkbook(db, detail.batch.id, 'orders'), { type: 'buffer' }).Sheets.rus00;
    const before = XLSX.read(original, { type: 'buffer' }).Sheets.rus00;
    assert.equal(after.J2.f, '3*3800');
    assert.equal(after.J2.v, before.J2.v);
    assert.equal(after.J2.t, before.J2.t);
  } finally { db.close(); }
});

test('삭제행이 있는 참조 수식·배열수식·이름 정의·내부 링크 파일은 안전하지 않은 다운로드를 만들지 않는다', async () => {
  for (const reference of ['formula', 'array', 'name', 'link']) {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([['상품명', '수량'], ['삭제 주문', 1], ['남길 주문', 2]]);
    XLSX.utils.book_append_sheet(workbook, sheet, '주문');
    const help = XLSX.utils.aoa_to_sheet([['보조 시트'], [3]]);
    if (reference === 'formula') help.A2.f = 'SUM(주문!B2:B3)';
    if (reference === 'array') { help.A2.f = '3*3800'; help.A2.F = 'A2:A3'; help.A3 = { t: 'n', v: 11400, F: 'A2:A3' }; }
    if (reference === 'name') workbook.Workbook = { Names: [{ Name: '주문수량', Ref: '주문!$B$2:$B$3' }] };
    if (reference === 'link') help.A2.l = { Target: '#주문!B3' };
    XLSX.utils.book_append_sheet(workbook, help, '안내');
    const original = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const db = openDatabase(':memory:');
    try {
      const detail = importFiles(db, [{ originalname: '참조.xlsx', buffer: original }]);
      reviseRows(db, detail.batch.id, detail.rows.map(row => ({ id: row.id, cleanedName: `정리 ${row.originalName}`, reviewNote: '', status: 'confirmed' })));
      const beforeDeletion = XLSX.read(await exportWorkbook(db, detail.batch.id, 'orders'), { type: 'buffer' });
      if (reference === 'formula') assert.equal(beforeDeletion.Sheets['안내'].A2.f, 'SUM(주문!B2:B3)');
      deleteRows(db, detail.batch.id, [detail.rows[0].id]);
      await assert.rejects(exportDownload(db, detail.batch.id), /참조 수식·배열 수식·이름 정의·내부 링크/);
      assert.equal(workbookRows(await exportWorkbook(db, detail.batch.id, 'names'))[1][1], '정리 남길 주문');
      assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files').get().content).equals(original));
    } finally { db.close(); }
  }
});

test('삭제한 작업은 모든 조회·수정·AI·다운로드 경로에서 숨기고 다른 작업을 유지한다', async t => {
  const app = createApp({ databasePath: ':memory:', client: mockClient(async () => assert.fail('삭제한 작업을 AI에 보내면 안 됩니다.')) });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  const db = app.locals.db, base = `http://127.0.0.1:${server.address().port}/api/batches`;
  const detail = importFiles(db, [file([['상품명'], ['삭제 작업']])]);
  const other = importFiles(db, [file([['상품명'], ['다른 작업']])]);
  const endpoint = `${base}/${detail.batch.id}`, json = { 'Content-Type': 'application/json' };
  const invalidRows = await fetch(`${endpoint}/rows`, { method: 'DELETE', headers: json,
    body: JSON.stringify({ rowIds: [detail.rows[0].id, other.rows[0].id] }) });
  assert.equal(invalidRows.status, 400);
  assert.equal(batchDetail(db, detail.batch.id).rows.length, 1);
  const rowsDeleted = await fetch(`${endpoint}/rows`, { method: 'DELETE', headers: json,
    body: JSON.stringify({ rowIds: [detail.rows[0].id] }) });
  assert.equal(rowsDeleted.status, 200);
  assert.equal((await rowsDeleted.json()).summary.total, 0);
  for (const kind of ['orders', 'names']) assert.equal((await fetch(`${endpoint}/export?kind=${kind}`)).status, 400);
  const deleted = await fetch(endpoint, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { deleted: true });
  assert.deepEqual((await (await fetch(base)).json()).batches.map(batch => batch.id), [other.batch.id]);
  const date = new Date(Date.parse(detail.batch.createdAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.deepEqual((await (await fetch(`${base}?date=${date}`)).json()).batches.map(batch => batch.id), [other.batch.id]);
  for (const [suffix, method, body] of [['', 'GET'], ['', 'DELETE'], ['/normalize', 'POST', '{}'], ['/rows', 'PATCH', '{"changes":[]}'],
    ['/rows', 'DELETE', JSON.stringify({ rowIds: [detail.rows[0].id] })], ['/export', 'GET'], ['/export?kind=names', 'GET']]) {
    assert.equal((await fetch(endpoint + suffix, { method, headers: json, ...(body ? { body } : {}) })).status, 404);
  }
  assert.equal((await fetch(`${base}/${other.batch.id}`)).status, 200);
  await assert.rejects(normalizeBatch(db, detail.batch.id, null, 'mock'), /작업을 찾을/);
  assert.throws(() => reviseRows(db, detail.batch.id, []), /작업을 찾을/);
  await assert.rejects(exportDownload(db, detail.batch.id), /작업을 찾을/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rows').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_files').get().n, 2);
});

test('AI 응답 도착 전 삭제 표시된 행이나 작업에는 생성 결과를 쓰지 않는다', async () => {
  for (const target of ['row', 'batch']) {
    const db = openDatabase(':memory:');
    try {
      const detail = importFiles(db, [file([['상품명'], ['첫 주문'], ['다음 주문']])]);
      const result = await normalizeBatch(db, detail.batch.id, mockClient(async request => {
        if (target === 'row') deleteRows(db, detail.batch.id, [detail.rows[0].id]);
        else deleteBatch(db, detail.batch.id);
        return responseFor(JSON.parse(request.input));
      }), 'mock');
      assert.equal(db.prepare('SELECT generated_name FROM rows WHERE id = ?').get(detail.rows[0].id).generated_name, '');
      if (target === 'row') assert.equal(result.summary.review, 1);
      else {
        assert.equal(result, null);
        assert.ok(db.prepare('SELECT generated_name FROM rows').all().every(row => row.generated_name === ''));
      }
    } finally { db.close(); }
  }
});

test('PATCH 한 번으로 직원 수정과 묶음 두 행 삭제를 저장하고 원본·AI명칭·이력·다운로드를 보존한다', async t => {
  const app = createApp({ databasePath: ':memory:', client: null });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  const db = app.locals.db;
  const source = file([['상품명', '수량'], ['남길 주문', 1], ['삭제 묶음', 2], ['삭제 묶음', 3], ['그대로', 4]]);
  const detail = importFiles(db, [source]);
  const other = importFiles(db, [file([['상품명'], ['다른 작업']])]);
  await normalizeBatch(db, detail.batch.id, mockClient(async request => responseFor(JSON.parse(request.input))), 'mock');
  reviseRows(db, detail.batch.id, [{ id: detail.rows[0].id, cleanedName: '사전 직원명', reviewNote: '이전 검수', status: 'confirmed' }]);
  const before = db.prepare('SELECT * FROM rows WHERE batch_id = ? ORDER BY id').all(detail.batch.id);
  const raw = db.prepare('SELECT raw_json FROM sheets WHERE batch_id = ?').all(detail.batch.id);
  const base = `http://127.0.0.1:${server.address().port}/api/batches/${detail.batch.id}`;
  const response = await fetch(`${base}/rows`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    changes: [{ id: detail.rows[0].id, cleanedName: '직원 최종명', reviewNote: '높이 검수', status: 'confirmed' }],
    deletedRowIds: detail.rows.slice(1, 3).map(row => row.id)
  }) });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.batch.rowCount, 2);
  assert.equal(saved.summary.total, 2);
  assert.equal(saved.rows[0].cleanedName, '직원 최종명');
  assert.equal(saved.rows[0].generatedName, '정리 남길 주문');
  assert.equal(saved.rows[0].reviewNote, '높이 검수');
  assert.deepEqual(saved.rows.map(row => row.id), [detail.rows[0].id, detail.rows[3].id]);
  const revisions = db.prepare('SELECT before_json, after_json FROM row_revisions ORDER BY id').all();
  assert.equal(revisions.length, 2);
  assert.equal(JSON.parse(revisions[1].before_json).cleanedName, '사전 직원명');
  assert.equal(JSON.parse(revisions[1].after_json).cleanedName, '직원 최종명');
  const allRows = db.prepare('SELECT * FROM rows WHERE batch_id = ? ORDER BY id').all(detail.batch.id);
  assert.equal(allRows.length, 4);
  for (const index of [1, 2]) assert.deepEqual({ ...allRows[index] }, { ...before[index], is_deleted: 1 });
  assert.deepEqual(db.prepare('SELECT raw_json FROM sheets WHERE batch_id = ?').all(detail.batch.id), raw);
  assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files WHERE batch_id = ?').get(detail.batch.id).content).equals(source.buffer));
  assert.equal(batchDetail(db, other.batch.id).rows[0].originalName, '다른 작업');
  const download = await fetch(`${base}/export`);
  assert.equal(download.status, 200);
  assert.deepEqual(workbookRows(Buffer.from(await download.arrayBuffer())), [['상품명', '수량'], ['직원 최종명', 1], ['정리 그대로', 4]]);
  assert.equal(workbookRows(await exportWorkbook(db, detail.batch.id, 'names')).length, 3);
});

test('PATCH는 삭제만 저장할 수 있고 모든 행 삭제 후 빈 작업은 다운로드하지 않는다', async t => {
  const app = createApp({ databasePath: ':memory:', client: null });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  const db = app.locals.db, detail = importFiles(db, [file([['상품명'], ['첫 주문'], ['마지막 주문']])]);
  const base = `http://127.0.0.1:${server.address().port}/api/batches/${detail.batch.id}`;
  for (const [index, row] of detail.rows.entries()) {
    const response = await fetch(`${base}/rows`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes: [], deletedRowIds: [row.id] }) });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.batch.rowCount, 1 - index);
    assert.equal(saved.rows.length, 1 - index);
  }
  for (const kind of ['orders', 'names']) assert.equal((await fetch(`${base}/export?kind=${kind}`)).status, 400);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rows WHERE is_deleted = 1').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM row_revisions').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM source_files').get().n, 1);
});

test('PATCH 수정·삭제의 잘못된 ID·중복·겹침·빈 제품명 또는 저장 오류는 모두 취소한다', async t => {
  const app = createApp({ databasePath: ':memory:', client: null });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  const db = app.locals.db, detail = importFiles(db, [file([['상품명'], ['수정 대상'], ['삭제 대상'], ['기존 삭제']])]);
  const other = importFiles(db, [file([['상품명'], ['다른 작업']])]);
  deleteRows(db, detail.batch.id, [detail.rows[2].id]);
  const change = { id: detail.rows[0].id, cleanedName: '직원 수정', reviewNote: '', status: 'confirmed' };
  const deleteId = detail.rows[1].id, deletedId = detail.rows[2].id;
  const endpoint = `http://127.0.0.1:${server.address().port}/api/batches/${detail.batch.id}/rows`;
  const expectedRows = db.prepare('SELECT * FROM rows ORDER BY id').all();
  const expectedBatches = db.prepare('SELECT * FROM batches ORDER BY id').all();
  const requests = [
    { changes: [change], deletedRowIds: [other.rows[0].id] },
    { changes: [change], deletedRowIds: [deleteId, deleteId] },
    { changes: [change], deletedRowIds: [deleteId, deletedId] },
    { changes: [change], deletedRowIds: [change.id] },
    { changes: [change, { ...change, id: other.rows[0].id }], deletedRowIds: [deleteId] },
    { changes: [change, change], deletedRowIds: [deleteId] },
    { changes: [{ ...change, cleanedName: ' ' }], deletedRowIds: [deleteId] },
    { changes: [{ ...change, id: deletedId }], deletedRowIds: [deleteId] },
    { changes: [null], deletedRowIds: [deleteId] },
    { changes: [], deletedRowIds: [] },
    { changes: [change], deletedRowIds: [0] },
    { changes: [change], deletedRowIds: 'wrong' }
  ];
  const checkRejected = async request => {
    const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    assert.equal(response.status, 400);
    assert.deepEqual(db.prepare('SELECT * FROM rows ORDER BY id').all(), expectedRows);
    assert.deepEqual(db.prepare('SELECT * FROM batches ORDER BY id').all(), expectedBatches);
    assert.equal(db.prepare('SELECT count(*) AS n FROM row_revisions').get().n, 0);
  };
  for (const request of requests) await checkRejected(request);
  db.exec(`CREATE TRIGGER reject_test_edit BEFORE UPDATE OF cleaned_name ON rows
    WHEN NEW.cleaned_name = '저장 실패 테스트' BEGIN SELECT RAISE(ABORT, '검증용 저장 오류'); END`);
  await checkRejected({ changes: [{ ...change, cleanedName: '저장 실패 테스트' }], deletedRowIds: [deleteId] });
});
