import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { openDatabase, batchDetail, deleteBatch, deleteRows } from '../lib/database.mjs';
import { importFiles, exportDownload } from '../lib/excel.mjs';
import { normalizeBatch, reviseRows, namingVersion } from '../lib/naming.mjs';
import { callLlm, listLlmPurposes, llmUsage } from '../lib/llm.mjs';
import { createApp } from '../server.mjs';

const file = (rows, headers = ['상품명', '옵션명', '수량'], name = '주문.xlsx') => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), '주문');
  return { originalname: name, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
};
const answer = (request, modify = item => item) => ({ model: 'mock-response-model',
  usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
  output_text: JSON.stringify({ items: JSON.parse(request.input).map(row => modify({ id: row.id,
    cleanedName: `정리 ${row.originalName} ${row.optionName}`.trim(), needsAttention: false, note: '' })) }) });
const mock = action => ({ responses: { create: action } });
const calls = db => db.prepare('SELECT * FROM llm_calls ORDER BY id').all();
const oldVersion = '0'.repeat(64);
const change = (row, cleanedName, status = 'confirmed', reviewNote = '') => ({ id: row.id, cleanedName, status, reviewNote });
const worksheetRows = buffer => {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(workbook.Sheets['주문'], { header: 1, raw: true, defval: null, blankrows: true });
};

test('최초 AI 호출 후 동일 주문 재업로드는 키 없이 재사용하며 원본 중복 주문을 유지한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const source = file([['원본', '옵션 A', 1], ['원본', '옵션 A', 2]]);
    const first = importFiles(db, [source]);
    let requests = 0;
    const generated = await normalizeBatch(db, first.batch.id, mock(async request => {
      requests++;
      const prompt = readFileSync(new URL('../prompts/product-names.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
      assert.equal(request.instructions, prompt);
      return answer(request);
    }), 'mock');
    assert.equal(requests, 1);
    assert.equal(generated.rows[0].nameSource, 'ai');
    assert.equal(generated.rows[0].reusedFromRowId, null);
    assert.equal(generated.rows[0].namingVersion, namingVersion);
    assert.equal(calls(db)[0].item_count, 1);
    const next = importFiles(db, [source]);
    const reused = await normalizeBatch(db, next.batch.id, null, 'mock');
    assert.equal(calls(db).length, 1);
    assert.equal(reused.summary.review, 2);
    for (const row of reused.rows) {
      assert.equal(row.nameSource, 'reused');
      assert.ok(generated.rows.some(old => old.id === row.reusedFromRowId));
      assert.equal(row.cleanedName, generated.rows[0].cleanedName);
      assert.equal(row.generatedName, generated.rows[0].generatedName);
      assert.equal(row.namingVersion, namingVersion);
    }
    const output = await exportDownload(db, next.batch.id);
    assert.deepEqual(worksheetRows(output.buffer), [['상품명', '옵션명', '수량'],
      ['정리 원본 옵션 A', '옵션 A', 1], ['정리 원본 옵션 A', '옵션 A', 2]]);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files WHERE batch_id = ?').get(next.batch.id).content).equals(source.buffer));
  } finally { db.close(); }
});

test('정확히 다른 옵션·다른 원본만 호출하고 현재 직원명·가져온 명칭은 덮지 않는다', async () => {
  const db = openDatabase(':memory:');
  try {
    const original = importFiles(db, [file([['원본', '옵션 A', 1]])]);
    await normalizeBatch(db, original.batch.id, mock(async request => answer(request)), 'mock');
    const current = importFiles(db, [file([['원본', '옵션 A', 1], ['원본', '옵션 B', 2],
      ['새 상품', '옵션 A', 3], ['원본', '옵션 A', 4]])]);
    reviseRows(db, current.batch.id, [change(current.rows[3], '직원이 이미 입력', 'review', '현재 검수 메모')]);
    const imported = importFiles(db, [file([['원본', '옵션 A', '가져온 명칭']], ['상품명', '옵션명', '정리된 제품명'])]);
    assert.equal(imported.rows[0].nameSource, 'imported');
    await normalizeBatch(db, imported.batch.id, null, 'mock');
    let sent;
    const result = await normalizeBatch(db, current.batch.id, mock(async request => { sent = JSON.parse(request.input); return answer(request); }), 'mock');
    assert.deepEqual(sent.map(row => [row.originalName, row.optionName]), [['원본', '옵션 B'], ['새 상품', '옵션 A']]);
    assert.equal(result.rows[0].nameSource, 'reused');
    assert.equal(result.rows[3].nameSource, 'manual');
    assert.equal(result.rows[3].namingVersion, namingVersion);
    assert.equal(result.rows[3].cleanedName, '직원이 이미 입력');
    assert.equal(result.rows[3].reviewNote, '현재 검수 메모');
    assert.equal(batchDetail(db, imported.batch.id).rows[0].cleanedName, '가져온 명칭');
    assert.equal(calls(db).length, 2);
    const spaced = importFiles(db, [file([['원본 ', '옵션 A', 1]])]);
    await normalizeBatch(db, spaced.batch.id, mock(async request => answer(request)), 'mock');
    assert.equal(calls(db).length, 3, '원본명 공백 차이를 임의로 같은 상품으로 판단하지 않습니다.');
  } finally { db.close(); }
});

test('검수 완료를 AI 초안보다 우선하며 옛 작업의 늦은 직원 수정이 새 복제본보다 우선한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const old = importFiles(db, [file([['원본', '옵션', 1]])]);
    await normalizeBatch(db, old.batch.id, mock(async request => answer(request)), 'mock');
    reviseRows(db, old.batch.id, [change(old.rows[0], '첫 직원명', 'confirmed', '직원 확인')]);
    db.prepare('UPDATE rows SET name_updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', old.rows[0].id);
    const copied = importFiles(db, [file([['원본', '옵션', 1]])]);
    await normalizeBatch(db, copied.batch.id, null, 'mock');
    assert.equal(db.prepare('SELECT name_updated_at FROM rows WHERE id = ?').get(copied.rows[0].id).name_updated_at, '2000-01-01T00:00:00.000Z');
    reviseRows(db, old.batch.id, [change(old.rows[0], '첫 직원명', 'confirmed', '같은 이름의 새 메모')]);
    const memoCopy = importFiles(db, [file([['원본', '옵션', 1]])]);
    assert.equal((await normalizeBatch(db, memoCopy.batch.id, null, 'mock')).rows[0].reviewNote, '같은 이름의 새 메모');
    const newerDraft = importFiles(db, [file([['원본', '옵션', 1]])]);
    db.prepare(`UPDATE rows SET generated_name = '더 최근 AI 초안', cleaned_name = '더 최근 AI 초안',
      name_source = 'ai', status = 'review', naming_version = ?, name_updated_at = '9999-01-01T00:00:00.000Z' WHERE id = ?`)
      .run(namingVersion, newerDraft.rows[0].id);
    reviseRows(db, old.batch.id, [change(old.rows[0], '늦게 수정한 직원 최종명', 'confirmed', '새 높이 확인')]);
    const updatedAt = db.prepare('SELECT name_updated_at FROM rows WHERE id = ?').get(old.rows[0].id).name_updated_at;
    reviseRows(db, old.batch.id, [change(old.rows[0], '늦게 수정한 직원 최종명', 'confirmed', '메모만 변경')]);
    assert.equal(db.prepare('SELECT name_updated_at FROM rows WHERE id = ?').get(old.rows[0].id).name_updated_at, updatedAt);
    const next = importFiles(db, [file([['원본', '옵션', 1]])]);
    const result = await normalizeBatch(db, next.batch.id, null, 'mock');
    assert.equal(result.rows[0].cleanedName, '늦게 수정한 직원 최종명');
    assert.equal(result.rows[0].status, 'confirmed');
    assert.equal(result.rows[0].reviewNote, '메모만 변경');
    assert.equal(result.rows[0].reusedFromRowId, old.rows[0].id);
    assert.equal(batchDetail(db, old.batch.id).rows[0].nameSource, 'ai', '직원 수정으로 최초 확보 경로를 지우지 않습니다.');
    assert.equal(calls(db).length, 1);
  } finally { db.close(); }
});

test('확인 필요 초안·사유를 재사용하되 검수 완료로 승격하지 않고 미확정 수동명은 재사용하지 않는다', async () => {
  const db = openDatabase(':memory:');
  try {
    const first = importFiles(db, [file([['불명확 원본', '', 1]])]);
    await normalizeBatch(db, first.batch.id, mock(async request => answer(request,
      item => ({ ...item, needsAttention: true, note: '소재와 옵션 확인 필요' }))), 'mock');
    const next = importFiles(db, [file([['불명확 원본', '', 1]])]);
    const result = await normalizeBatch(db, next.batch.id, null, 'mock');
    assert.equal(result.summary.attention, 1);
    assert.equal(result.rows[0].reviewNote, '소재와 옵션 확인 필요');
    const manual = importFiles(db, [file([['수동 원본', '', 1]])]);
    reviseRows(db, manual.batch.id, [change(manual.rows[0], '아직 확인 전 수동명', 'review')]);
    const pending = importFiles(db, [file([['수동 원본', '', 1]])]);
    await assert.rejects(normalizeBatch(db, pending.batch.id, null, 'mock'), /OPENAI_API_KEY/);
    assert.equal(batchDetail(db, pending.batch.id).rows[0].status, 'pending');
    assert.equal(calls(db).length, 1);
  } finally { db.close(); }
});

test('최초 출처의 행·작업 삭제는 활성 복제본을 통한 재사용도 차단하며 사용량 기록은 유지한다', async () => {
  for (const target of ['row', 'batch']) {
    const db = openDatabase(':memory:');
    try {
      const first = importFiles(db, [file([['원본', '', 1]])]);
      await normalizeBatch(db, first.batch.id, mock(async request => answer(request)), 'mock');
      const copy = importFiles(db, [file([['원본', '', 1]])]);
      await normalizeBatch(db, copy.batch.id, null, 'mock');
      reviseRows(db, copy.batch.id, [change(copy.rows[0], '복제 후 직원 수정명', 'confirmed', '직원 검수')]);
      assert.equal(batchDetail(db, copy.batch.id).rows[0].reusedFromRowId, first.rows[0].id);
      if (target === 'row') deleteRows(db, first.batch.id, [first.rows[0].id]);
      else deleteBatch(db, first.batch.id);
      const next = importFiles(db, [file([['원본', '', 1]])]);
      const result = await normalizeBatch(db, next.batch.id, mock(async request => answer(request)), 'mock');
      assert.equal(result.rows[0].nameSource, 'ai');
      assert.equal(result.rows[0].reusedFromRowId, null);
      assert.equal(calls(db).length, 2);
      assert.equal(batchDetail(db, copy.batch.id).rows[0].nameSource, 'reused');
      assert.equal(db.prepare('SELECT count(*) AS n FROM source_files').get().n, 3);
    } finally { db.close(); }
  }
});

test('수동 확정명 복제본을 비운 뒤 새 AI 명칭을 만들면 이전 재사용 출처를 분리한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const first = importFiles(db, [file([['원본', '', 1]])]);
    reviseRows(db, first.batch.id, [change(first.rows[0], '수동 확정명')]);
    const next = importFiles(db, [file([['원본', '', 1]])]);
    await normalizeBatch(db, next.batch.id, null, 'mock');
    reviseRows(db, next.batch.id, [change(next.rows[0], '', 'pending')]);
    deleteBatch(db, first.batch.id);
    const generated = await normalizeBatch(db, next.batch.id, mock(async request => answer(request)), 'mock');
    assert.equal(generated.rows[0].nameSource, 'ai');
    assert.equal(generated.rows[0].reusedFromRowId, null);
    const final = importFiles(db, [file([['원본', '', 1]])]);
    assert.equal((await normalizeBatch(db, final.batch.id, null, 'mock')).rows[0].reusedFromRowId, next.rows[0].id);
    assert.equal(calls(db).length, 1);
  } finally { db.close(); }
});

test('새 호출 응답이 도착하기 전 저장된 직원명을 덮지 않는다', async () => {
  const db = openDatabase(':memory:');
  try {
    const batch = importFiles(db, [file([['원본', '', 1]])]);
    const result = await normalizeBatch(db, batch.batch.id, mock(async request => {
      reviseRows(db, batch.batch.id, [change(batch.rows[0], '먼저 저장된 직원명')]);
      return answer(request);
    }), 'mock');
    assert.equal(result.rows[0].cleanedName, '먼저 저장된 직원명');
    assert.equal(result.rows[0].nameSource, 'manual');
    assert.equal(result.rows[0].generatedName, '');
    assert.equal(calls(db)[0].status, 'succeeded');
  } finally { db.close(); }
});

test('21개 고유 상품은 2호출이며 실패·형식 불량·재시도마다 별도 기록을 남긴다', async () => {
  const db = openDatabase(':memory:');
  try {
    const batch = importFiles(db, [file(Array.from({ length: 21 }, (_, index) => [`상품 ${index}`, '', index]))]);
    let count = 0;
    await assert.rejects(normalizeBatch(db, batch.batch.id, mock(async request => {
      if (++count === 2) throw Object.assign(new Error('mock connection failure'), { name: 'APIConnectionError' });
      return answer(request);
    }), 'mock'), /연결에 실패/);
    assert.deepEqual(calls(db).map(row => [row.item_count, row.status]), [[20, 'succeeded'], [1, 'failed']]);
    assert.equal(calls(db)[1].usage_json, null, '미확인 사용량은 0으로 기록하지 않습니다.');
    assert.equal(batchDetail(db, batch.batch.id).summary.review, 20);
    assert.equal(batchDetail(db, batch.batch.id).rows.at(-1).namingVersion, '');
    await assert.rejects(normalizeBatch(db, batch.batch.id, mock(async request => ({ ...answer(request), output_text: '{bad' })), 'mock'), /응답 형식/);
    assert.equal(calls(db)[2].status, 'failed');
    assert.equal(batchDetail(db, batch.batch.id).rows.at(-1).namingVersion, '');
    assert.equal(JSON.parse(calls(db)[2].usage_json).total_tokens, 200, '형식이 잘못되어도 응답 사용량은 보존합니다.');
    await normalizeBatch(db, batch.batch.id, mock(async request => answer(request)), 'mock');
    assert.equal(calls(db)[3].status, 'succeeded');
    assert.equal(calls(db)[3].item_count, 1);
    assert.ok(batchDetail(db, batch.batch.id).rows.every(row => row.namingVersion === namingVersion));
    assert.equal(calls(db)[3].model, 'mock-response-model');
    assert.ok(calls(db).every(row => row.finished_at));
    const other = importFiles(db, [file(Array.from({ length: 21 }, (_, index) => [`다른 상품 ${index}`, '', 1]))]);
    await normalizeBatch(db, other.batch.id, mock(async request => answer(request)), 'mock');
    assert.deepEqual(calls(db).slice(-2).map(row => row.item_count), [20, 1]);
  } finally { db.close(); }
});

test('거절·누락 ID 응답은 실패로 집계하고 어떠한 상품명도 저장하지 않는다', async () => {
  for (const invalid of [request => ({ ...answer(request), output: [{ content: [{ type: 'refusal' }] }] }),
    request => ({ ...answer(request), output_text: '{"items":[]}' })]) {
    const db = openDatabase(':memory:');
    try {
      const batch = importFiles(db, [file([['원본', '', 1]])]);
      await assert.rejects(normalizeBatch(db, batch.batch.id, mock(async request => invalid(request)), 'mock'));
      assert.equal(calls(db)[0].status, 'failed');
      assert.equal(batchDetail(db, batch.batch.id).rows[0].cleanedName, '');
    } finally { db.close(); }
  }
});

test('한국 자정 경계·목적별 집계·0회 날짜·진행 중 요청을 구분하고 조회는 AI를 호출하지 않는다', async () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO llm_purposes (code, name) VALUES (?, ?)').run('packing', '포장 확인');
    const batch = importFiles(db, [file([['원본', '', 1]])]);
    await normalizeBatch(db, batch.batch.id, mock(async request => answer(request)), 'mock');
    await assert.rejects(callLlm(db, { purposeCode: 'packing', itemCount: 1 }, mock(async () => { throw new Error('mock'); }), { model: 'mock' }));
    db.prepare('UPDATE llm_calls SET started_at = ? WHERE id = ?').run('2026-10-09T14:59:59.999Z', 1);
    db.prepare('UPDATE llm_calls SET started_at = ? WHERE id = ?').run('2026-10-09T15:00:00.000Z', 2);
    db.prepare('UPDATE app_metadata SET value = ? WHERE key = ?').run('2026-10-09T01:00:00.000Z', 'llm_tracking_started_at');
    let finish;
    const pending = callLlm(db, { purposeCode: 'packing', itemCount: 1 }, mock(() => new Promise(resolve => { finish = resolve; })), { model: 'mock' });
    db.prepare('UPDATE llm_calls SET started_at = ? WHERE id = ?').run('2026-10-10T14:59:59.999Z', 3);
    const snapshot = llmUsage(db, '2026-10-08', '2026-10-11');
    assert.equal(snapshot.days.length, 12);
    assert.deepEqual(snapshot.totals, { calls: 3, succeeded: 1, failed: 1, running: 1 });
    assert.deepEqual(snapshot.days.find(row => row.date === '2026-10-09' && row.purposeCode === 'product_names'),
      { date: '2026-10-09', purposeCode: 'product_names', purposeName: '상품명 정리', calls: 1, succeeded: 1, failed: 0, running: 0 });
    assert.equal(snapshot.days.find(row => row.date === '2026-10-10' && row.purposeCode === 'packing').calls, 2);
    assert.ok(snapshot.days.filter(row => ['2026-10-08', '2026-10-11'].includes(row.date)).every(row => row.calls === 0));
    assert.equal(snapshot.trackingStartedAt, '2026-10-09T01:00:00.000Z');
    finish({ model: 'mock', usage: { total_tokens: 1 } });
    await pending;
    db.prepare('UPDATE llm_purposes SET active = 0 WHERE code = ?').run('packing');
    deleteBatch(db, batch.batch.id);
    assert.deepEqual(llmUsage(db, '2026-10-09', '2026-10-10', 'packing').totals, { calls: 2, succeeded: 1, failed: 1, running: 0 });
    assert.equal(listLlmPurposes(db).purposes.find(row => row.code === 'packing').active, false);
    const before = calls(db).length;
    await assert.rejects(callLlm(db, { purposeCode: 'packing', itemCount: 1 }, mock(async () => assert.fail('비활성 목적은 호출하면 안 됩니다.')), { model: 'mock' }), /목적/);
    assert.equal(calls(db).length, before);
  } finally { db.close(); }
});

test('기존 DB 자동 이전·재시작은 검수이력을 보존하고 기존 자료의 출처를 사실대로 표시한다', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-reuse-test-'));
  const filename = path.join(directory, 'legacy.sqlite');
  let db;
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE batches (id INTEGER PRIMARY KEY, name TEXT NOT NULL, file_count INTEGER NOT NULL,
      row_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      CREATE TABLE sheets (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, source_file TEXT NOT NULL,
        source_sheet TEXT NOT NULL, raw_json TEXT NOT NULL, header_index INTEGER NOT NULL);
      CREATE TABLE rows (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, sheet_id INTEGER NOT NULL,
        source_row INTEGER NOT NULL, original_name TEXT NOT NULL, product_name TEXT NOT NULL, option_name TEXT NOT NULL,
        generated_name TEXT NOT NULL DEFAULT '', cleaned_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        review_note TEXT NOT NULL DEFAULT '');
      CREATE TABLE row_revisions (id INTEGER PRIMARY KEY, row_id INTEGER NOT NULL, before_json TEXT NOT NULL,
        after_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
      INSERT INTO batches VALUES (1, '기존 작업', 1, 2, '2000-01-01T00:00:00.000Z');
      INSERT INTO sheets VALUES (1, 1, '기존.xlsx', '주문', '[]', 0);
      INSERT INTO rows VALUES (1, 1, 1, 2, 'AI 원본', 'AI 원본', '', 'AI 초안', '직원 최종명', 'confirmed', '검수');
      INSERT INTO rows VALUES (2, 1, 1, 3, '기존 원본', '기존 원본', '', '', '기존 직원명', 'confirmed', '');`);
    const before = JSON.stringify({ cleanedName: 'AI 초안', status: 'review', reviewNote: '' });
    const after = JSON.stringify({ cleanedName: '직원 최종명', status: 'confirmed', reviewNote: '검수' });
    legacy.prepare('INSERT INTO row_revisions VALUES (1, 1, ?, ?, ?)').run(before, after, '2001-01-01T00:00:00.000Z');
    legacy.close();
    db = openDatabase(filename);
    const metadata = listLlmPurposes(db).trackingStartedAt;
    assert.deepEqual(batchDetail(db, 1).rows.map(row => row.nameSource), ['ai', 'imported']);
    assert.equal(db.prepare('SELECT name_updated_at FROM rows WHERE id = 1').get().name_updated_at, '2001-01-01T00:00:00.000Z');
    assert.deepEqual({ ...db.prepare('SELECT before_json, after_json FROM row_revisions').get() }, { before_json: before, after_json: after });
    assert.equal(calls(db).length, 0, '이전 상품명에서 과거 API 횟수를 추정하지 않습니다.');
    assert.ok(batchDetail(db, 1).rows.every(row => row.namingVersion === ''));
    const originalRows = db.prepare('SELECT * FROM rows WHERE batch_id = 1 ORDER BY id').all();
    const next = importFiles(db, [file([['AI 원본', '', 1], ['기존 원본', '', 2]])]);
    let sent;
    const regenerated = await normalizeBatch(db, next.batch.id, mock(async request => {
      sent = JSON.parse(request.input); return answer(request);
    }), 'mock');
    assert.deepEqual(sent.map(row => [row.previousName, row.previousReviewNote || '']), [['직원 최종명', '검수'], ['기존 직원명', '']]);
    assert.deepEqual(regenerated.rows.map(row => row.cleanedName), ['정리 AI 원본', '정리 기존 원본']);
    assert.ok(regenerated.rows.every(row => row.namingVersion === namingVersion && row.nameSource === 'ai'));
    assert.deepEqual(db.prepare('SELECT * FROM rows WHERE batch_id = 1 ORDER BY id').all(), originalRows);
    const newest = importFiles(db, [file([['AI 원본', '', 1], ['기존 원본', '', 2]])]);
    const reused = await normalizeBatch(db, newest.batch.id, null, 'mock');
    assert.deepEqual(reused.rows.map(row => row.cleanedName), regenerated.rows.map(row => row.cleanedName));
    assert.equal(calls(db).length, 1);
    db.prepare(`INSERT INTO llm_calls (purpose_code, model, item_count, started_at) VALUES ('product_names', 'mock', 1, ?)`)
      .run('2002-01-01T00:00:00.000Z');
    db.close(); db = openDatabase(filename);
    assert.equal(listLlmPurposes(db).trackingStartedAt, metadata);
    assert.equal(calls(db)[1].status, 'failed');
    assert.equal(calls(db)[1].error_code, 'interrupted');
    assert.equal(calls(db)[1].usage_json, null);
    assert.deepEqual(batchDetail(db, newest.batch.id).rows.map(row => row.nameSource), ['reused', 'reused']);
    assert.ok(batchDetail(db, newest.batch.id).rows.every(row => row.namingVersion === namingVersion));
    assert.equal(db.prepare('SELECT count(*) AS n FROM row_revisions').get().n, 1);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('지침 버전이 바뀌면 새 중복 주문만 재정리하고 이전 검수·원본은 보존하며 다음 주문은 재사용한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const source = file([['면20수 상품', '면100수 새싹', 1], ['면20수 상품', '면100수 새싹', 2]]);
    const old = importFiles(db, [source]);
    await normalizeBatch(db, old.batch.id, mock(async request => answer(request)), 'mock');
    reviseRows(db, old.batch.id, old.rows.map(row => change(row, '이전 직원 확정명', 'confirmed', '디자인 검수 메모')));
    db.prepare('UPDATE rows SET naming_version = ? WHERE batch_id = ?').run(oldVersion, old.batch.id);
    const originalRows = db.prepare('SELECT * FROM rows WHERE batch_id = ? ORDER BY id').all(old.batch.id);
    const revisions = db.prepare('SELECT * FROM row_revisions ORDER BY id').all();
    const next = importFiles(db, [source]);
    let requests = 0;
    const updated = await normalizeBatch(db, next.batch.id, mock(async request => {
      requests++;
      const input = JSON.parse(request.input);
      assert.equal(input.length, 1, '버전 재정리도 중복 주문은 API 입력 하나로 묶습니다.');
      assert.equal(input[0].previousName, '이전 직원 확정명');
      assert.equal(input[0].previousReviewNote, '디자인 검수 메모');
      assert.deepEqual(Object.keys(input[0]).sort(), ['id', 'originalName', 'productName', 'optionName', 'previousName', 'previousReviewNote'].sort());
      return answer(request, item => ({ ...item, cleanedName: '새 지침에 따른 모의 명칭' }));
    }), 'mock');
    assert.equal(requests, 1);
    assert.ok(updated.rows.every(row => row.namingVersion === namingVersion && row.status === 'review' && row.nameSource === 'ai'));
    assert.deepEqual(db.prepare('SELECT * FROM rows WHERE batch_id = ? ORDER BY id').all(old.batch.id), originalRows);
    assert.deepEqual(db.prepare('SELECT * FROM row_revisions ORDER BY id').all(), revisions);
    assert.ok(Buffer.from(db.prepare('SELECT content FROM source_files WHERE batch_id = ?').get(old.batch.id).content).equals(source.buffer));
    assert.deepEqual(worksheetRows((await exportDownload(db, next.batch.id)).buffer), [['상품명', '옵션명', '수량'],
      ['새 지침에 따른 모의 명칭', '면100수 새싹', 1], ['새 지침에 따른 모의 명칭', '면100수 새싹', 2]]);
    assert.deepEqual(worksheetRows((await exportDownload(db, old.batch.id)).buffer), [['상품명', '옵션명', '수량'],
      ['이전 직원 확정명', '면100수 새싹', 1], ['이전 직원 확정명', '면100수 새싹', 2]]);
    reviseRows(db, old.batch.id, old.rows.map(row => change(row, '더 늦게 수정한 구버전 확정명', 'confirmed', '구버전 메모 변경')));
    assert.ok(batchDetail(db, old.batch.id).rows.every(row => row.namingVersion === oldVersion));
    const final = importFiles(db, [source]);
    const reused = await normalizeBatch(db, final.batch.id, null, 'mock');
    assert.ok(reused.rows.every(row => row.cleanedName === '새 지침에 따른 모의 명칭'
      && row.namingVersion === namingVersion && row.nameSource === 'reused' && row.status === 'review'));
    assert.ok(reused.rows.every(row => updated.rows.some(source => source.id === row.reusedFromRowId)));
    assert.equal(calls(db).length, 2);
  } finally { db.close(); }
});

test('구버전 재정리의 호출 실패·불량 응답은 버전을 확정하지 않고 재시도 후에만 재사용한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const first = importFiles(db, [file([['원본', '기존 옵션', 1]])]);
    reviseRows(db, first.batch.id, [change(first.rows[0], '이전 확정명', 'confirmed', '이전 확인 메모')]);
    db.prepare('UPDATE rows SET naming_version = ? WHERE id = ?').run(oldVersion, first.rows[0].id);
    const snapshot = db.prepare('SELECT * FROM rows WHERE id = ?').get(first.rows[0].id);
    const next = importFiles(db, [file([['원본', '기존 옵션', 1], ['원본', '기존 옵션', 2]])]);
    await assert.rejects(normalizeBatch(db, next.batch.id, mock(async () => {
      throw Object.assign(new Error('mock timeout'), { name: 'APIConnectionTimeoutError' });
    }), 'mock'), /연결에 실패/);
    await assert.rejects(normalizeBatch(db, next.batch.id, mock(async request => ({ ...answer(request), output_text: '{bad' })), 'mock'), /응답 형식/);
    assert.ok(batchDetail(db, next.batch.id).rows.every(row => row.namingVersion === '' && !row.generatedName && !row.cleanedName));
    assert.deepEqual(db.prepare('SELECT * FROM rows WHERE id = ?').get(first.rows[0].id), snapshot);
    const result = await normalizeBatch(db, next.batch.id, mock(async request => {
      const input = JSON.parse(request.input);
      assert.equal(input[0].previousName, '이전 확정명');
      return answer(request, item => ({ ...item, cleanedName: '새 모의 명칭', needsAttention: true, note: '선택 옵션 확인 필요' }));
    }), 'mock');
    assert.ok(result.rows.every(row => row.namingVersion === namingVersion && row.status === 'attention'));
    assert.deepEqual(calls(db).map(row => [row.status, row.item_count]), [['failed', 1], ['failed', 1], ['succeeded', 1]]);
    const duplicate = importFiles(db, [file([['원본', '기존 옵션', 3]])]);
    const reused = await normalizeBatch(db, duplicate.batch.id, null, 'mock');
    assert.equal(reused.rows[0].namingVersion, namingVersion);
    assert.equal(reused.rows[0].status, 'attention');
    assert.equal(reused.rows[0].reviewNote, '선택 옵션 확인 필요');
    assert.equal(calls(db).length, 3);
    const otherOption = importFiles(db, [file([['원본', '다른 옵션', 4]])]);
    await normalizeBatch(db, otherOption.batch.id, mock(async request => {
      assert.equal(JSON.parse(request.input)[0].previousName, undefined, '다른 옵션의 직원명을 참고로 보내지 않습니다.');
      return answer(request);
    }), 'mock');
  } finally { db.close(); }
});

test('빈 행의 새 수동 확정명만 현버전으로 재사용하고 기존 생성·가져온 명칭의 수정은 구버전을 유지한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const fresh = importFiles(db, [file([['직접 정리 원본', '옵션', 1]])]);
    reviseRows(db, fresh.batch.id, [change(fresh.rows[0], '직원이 새 지침으로 정리한 이름')]);
    assert.equal(batchDetail(db, fresh.batch.id).rows[0].namingVersion, namingVersion);
    const copied = importFiles(db, [file([['직접 정리 원본', '옵션', 2]])]);
    const reused = await normalizeBatch(db, copied.batch.id, null, 'mock');
    assert.equal(reused.rows[0].cleanedName, '직원이 새 지침으로 정리한 이름');
    assert.equal(reused.rows[0].status, 'confirmed');
    assert.equal(reused.rows[0].namingVersion, namingVersion);
    const generated = importFiles(db, [file([['AI 원본', '', 1]])]);
    await normalizeBatch(db, generated.batch.id, mock(async request => answer(request)), 'mock');
    db.prepare('UPDATE rows SET naming_version = ? WHERE id = ?').run(oldVersion, generated.rows[0].id);
    reviseRows(db, generated.batch.id, [change(generated.rows[0], '구버전 결과 직원 수정명')]);
    assert.equal(batchDetail(db, generated.batch.id).rows[0].namingVersion, oldVersion);
    const imported = importFiles(db, [file([['가져온 원본', '예전 명칭']], ['상품명', '정리된 제품명'])]);
    reviseRows(db, imported.batch.id, [change(imported.rows[0], '기존 명칭 검수 수정')]);
    assert.equal(batchDetail(db, imported.batch.id).rows[0].namingVersion, '');
    assert.equal(calls(db).length, 1);
  } finally { db.close(); }
});

test('API만으로 업로드→정리→상태 판단→검수→다운로드·재사용·집계를 수행한다', async t => {
  let requests = 0;
  const app = createApp({ databasePath: ':memory:', client: mock(async request => {
    requests++; return answer(request, item => item.id % 2 ? item : { ...item, needsAttention: true, note: '옵션 확인' });
  }) });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const source = file([['상품 A', '옵션', 2], ['상품 B', '다른 옵션', 3], ['상품 A', '옵션', 4]],
    ['상품명', '옵션명', '수량']);
  const upload = async () => {
    const form = new FormData(); form.append('files', new Blob([source.buffer]), source.originalname);
    const response = await fetch(`${base}/import`, { method: 'POST', body: form });
    assert.equal(response.status, 201); return response.json();
  };
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const batch = await upload();
  const normalized = await (await fetch(`${base}/batches/${batch.batch.id}/normalize`, json('POST', {}))).json();
  assert.equal(normalized.summary.attention, 1);
  assert.equal(normalized.summary.review, 2);
  assert.ok(normalized.rows.every(row => row.namingVersion === namingVersion));
  const reviewed = await fetch(`${base}/batches/${batch.batch.id}/rows`, json('PATCH', {
    changes: normalized.rows.map(row => change(row, row.cleanedName, 'confirmed', '직원 확인'))
  }));
  assert.equal(reviewed.status, 200);
  assert.equal((await reviewed.json()).summary.confirmed, 3);
  const exported = await fetch(`${base}/batches/${batch.batch.id}/export`);
  assert.equal(exported.status, 200);
  assert.deepEqual(worksheetRows(Buffer.from(await exported.arrayBuffer())), [['상품명', '옵션명', '수량'],
    ['정리 상품 A 옵션', '옵션', 2], ['정리 상품 B 다른 옵션', '다른 옵션', 3], ['정리 상품 A 옵션', '옵션', 4]]);
  const copy = await upload();
  const reused = await (await fetch(`${base}/batches/${copy.batch.id}/normalize`, json('POST', {}))).json();
  assert.equal(reused.summary.confirmed, 3);
  assert.ok(reused.rows.every(row => row.nameSource === 'reused'));
  assert.ok(reused.rows.every(row => row.namingVersion === namingVersion));
  assert.equal(requests, 1);
  const purposes = await (await fetch(`${base}/llm/purposes`)).json();
  assert.deepEqual(purposes.purposes, [{ code: 'product_names', name: '상품명 정리', active: true },
    { code: 'product_names_preview', name: '신규 주문현황 상품명 정리', active: true }]);
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const usage = await (await fetch(`${base}/llm/usage?from=${date}&to=${date}&purpose=product_names`)).json();
  assert.deepEqual(usage.totals, { calls: 1, succeeded: 1, failed: 0, running: 0 });
  for (const query of ['', 'from=2026-02-30&to=2026-03-01', 'from=2026-10-10&to=2026-10-09',
    'from=2026-10-10&to=2026-10-10&purpose=missing', 'from=2026-10-10&to=wrong',
    'from=0001-01-01&to=9999-12-31', 'from=0000-01-01&to=2026-10-10',
    'from=2026-10-10&from=2026-10-11&to=2026-10-11']) {
    assert.equal((await fetch(`${base}/llm/usage?${query}`)).status, 400);
  }
  await fetch(`${base}/batches/${batch.batch.id}`, { method: 'DELETE' });
  assert.equal((await (await fetch(`${base}/llm/usage?from=${date}&to=${date}`)).json()).totals.calls, 1);
  assert.equal(requests, 1);
});
