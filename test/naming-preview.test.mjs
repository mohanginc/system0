import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { openDatabase, deleteBatch, deleteRows } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { normalizeBatch, normalizePreviewNames, reviseRows, namingVersion } from '../lib/naming.mjs';

const mock = action => ({ responses: { create: action } });
const input = (id, originalName = `원본 ${id}`, optionName = '선택 옵션') => ({ id, originalName,
  productName: originalName, optionName });
const answer = (request, modify = item => item) => ({ model: 'mock-response',
  usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 },
  output_text: JSON.stringify({ items: JSON.parse(request.input).map(row => modify({ id: row.id,
    cleanedName: `정리 ${row.originalName} ${row.optionName}`, needsAttention: false, note: '' })).reverse() }) });
function database(t) {
  const db = openDatabase(':memory:');
  db.prepare('INSERT OR IGNORE INTO llm_purposes (code, name) VALUES (?, ?)')
    .run('product_names_preview', '신규 주문 상품명 정리');
  t.after(() => db.close());
  return db;
}
function order(db, originalName, optionName = '선택 옵션') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['상품명', '옵션명', '수량'], [originalName, optionName, 3],
  ]), '주문');
  return importFiles(db, [{ originalname: '모의 주문.xlsx',
    buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) }]);
}
function confirmed(db, originalName, optionName, cleanedName) {
  const detail = order(db, originalName, optionName);
  return reviseRows(db, detail.batch.id, [{ id: detail.rows[0].id, cleanedName,
    status: 'confirmed', reviewNote: '직원 검수 메모' }]);
}
const snapshot = db => Object.fromEntries(['batches', 'sheets', 'source_files', 'rows', 'row_revisions']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
const calls = db => db.prepare('SELECT * FROM llm_calls ORDER BY id').all();

test('미리보기는 입력 순서와 중복을 유지하고 주문·정리 데이터는 저장하지 않으며 고객정보를 전송하지 않는다', async t => {
  const db = database(t);
  confirmed(db, '다른 기존 상품', '옵션', '보존할 직원 명칭');
  const before = snapshot(db);
  const inputs = [{ ...input(8, '같은 원본', '옵션 A'), recipient: '모의 수취인', phone: '010-0000-0000',
    address: '비공개 전체 주소 101동 202호', productOrderId: '202610170000000001',
    previousName: '외부에서 주입한 이름', previousReviewNote: '외부에서 주입한 메모' },
  input(3, '다른 원본', '옵션 B'), input(19, '같은 원본', '옵션 A')];
  const originalInputs = structuredClone(inputs);
  let requests = 0;
  const client = mock(async request => {
    requests++;
    assert.equal(request.store, false);
    assert.equal(request.model, 'mock-preview');
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    assert.ok(request.instructions.trim());
    const sent = JSON.parse(request.input);
    assert.equal(sent.length, 2);
    for (const row of sent) assert.deepEqual(Object.keys(row), ['id', 'originalName', 'productName', 'optionName']);
    for (const value of ['모의 수취인', '010-0000-0000', '비공개 전체 주소', '202610170000000001', '외부에서 주입한']) {
      assert.ok(!request.input.includes(value));
    }
    return answer(request, item => ({ ...item, cleanedName: ` ${item.cleanedName} `,
      needsAttention: item.id === 3, note: item.id === 3 ? ' 옵션 확인 필요 ' : '' }));
  });
  const result = await normalizePreviewNames(db, inputs, client, 'mock-preview');
  assert.deepEqual(result.map(row => row.id), [8, 3, 19]);
  assert.equal(result[0].cleanedName, result[2].cleanedName);
  assert.equal(result[1].needsAttention, true);
  assert.equal(result[1].note, '옵션 확인 필요');
  assert.ok(result.every(row => row.source === 'ai' && row.cleanedName === row.cleanedName.trim()));
  assert.deepEqual(inputs, originalInputs);
  assert.deepEqual(snapshot(db), before);
  assert.equal(calls(db).length, 1);
  assert.equal(calls(db)[0].purpose_code, 'product_names_preview');
  assert.equal(calls(db)[0].batch_id, null);
  assert.equal(calls(db)[0].item_count, 2);
  assert.equal(calls(db)[0].status, 'succeeded');
  assert.deepEqual(JSON.parse(calls(db)[0].usage_json), { input_tokens: 30, output_tokens: 20, total_tokens: 50 });
  await normalizePreviewNames(db, inputs, client, 'mock-preview');
  assert.equal(requests, 2, '미리보기 결과는 다음 갱신의 영구 캐시가 되지 않습니다.');
  assert.deepEqual(snapshot(db), before);
});

test('현 지침의 직원 완료명 우선과 확인 필요 메모를 키 없이 정확히 재사용한다', async t => {
  const db = database(t);
  const staff = confirmed(db, '원본 A', '옵션 A', '직원이 확정한 명칭');
  db.prepare('UPDATE rows SET name_updated_at = ? WHERE id = ?').run('2026-10-01T00:00:00Z', staff.rows[0].id);
  const draft = order(db, '원본 A', '옵션 A');
  db.prepare(`UPDATE rows SET generated_name = '최근 AI 초안', cleaned_name = '최근 AI 초안',
    status = 'review', naming_version = ?, name_updated_at = '2026-10-17T00:00:00Z' WHERE id = ?`)
    .run(namingVersion, draft.rows[0].id);
  const old = confirmed(db, '원본 A', '옵션 A', '구버전 직원 명칭');
  db.prepare('UPDATE rows SET naming_version = ? WHERE id = ?').run('old-version', old.rows[0].id);
  const attention = order(db, '원본 B', '옵션 B');
  await normalizeBatch(db, attention.batch.id, mock(async request => answer(request,
    item => ({ ...item, needsAttention: true, note: '원본 옵션 재확인' }))), 'mock');
  const before = snapshot(db), priorCalls = calls(db).length;
  const result = await normalizePreviewNames(db, [input(1, '원본 A', '옵션 A'), input(2, '원본 B', '옵션 B')], null, 'mock');
  assert.deepEqual(result[0], { id: 1, cleanedName: '직원이 확정한 명칭', needsAttention: false,
    note: '직원 검수 메모', source: 'reused' });
  assert.equal(result[1].needsAttention, true);
  assert.equal(result[1].note, '원본 옵션 재확인');
  assert.equal(result[1].source, 'reused');
  assert.deepEqual(snapshot(db), before);
  assert.equal(calls(db).length, priorCalls);
});

test('구버전·공백 차이·다른 옵션은 재정리하고 현재 결과만 재사용한다', async t => {
  const db = database(t);
  const old = confirmed(db, '구버전 원본', '옵션 A', '예전 확정명');
  db.prepare('UPDATE rows SET naming_version = ? WHERE id = ?').run('old-version', old.rows[0].id);
  confirmed(db, '정확 원본', '옵션 A', '현 지침 명칭');
  const before = snapshot(db);
  const result = await normalizePreviewNames(db, [input(1, '구버전 원본', '옵션 A'),
    input(2, '정확 원본 ', '옵션 A'), input(3, '정확 원본', '옵션 B'), input(4, '정확 원본', '옵션 A')],
  mock(async request => {
    const sent = JSON.parse(request.input);
    assert.deepEqual(sent.map(row => row.id), [1, 2, 3]);
    assert.ok(sent.every(row => !('previousName' in row) && !('previousReviewNote' in row)));
    return answer(request);
  }), 'mock');
  assert.deepEqual(result.map(row => row.source), ['ai', 'ai', 'ai', 'reused']);
  assert.equal(result[3].cleanedName, '현 지침 명칭');
  assert.equal(calls(db)[0].item_count, 3);
  assert.deepEqual(snapshot(db), before);
});

test('삭제한 작업·행과 삭제된 원출처의 복제 명칭은 재사용하지 않는다', async t => {
  const db = database(t);
  const deletedRow = confirmed(db, '삭제 행 원본', '옵션', '삭제 행 명칭');
  deleteRows(db, deletedRow.batch.id, [deletedRow.rows[0].id]);
  const deletedBatch = confirmed(db, '삭제 작업 원본', '옵션', '삭제 작업 명칭');
  deleteBatch(db, deletedBatch.batch.id);
  const origin = confirmed(db, '복제 원본', '옵션', '원출처의 명칭');
  const copy = order(db, '복제 원본', '옵션');
  await normalizeBatch(db, copy.batch.id, null, 'mock');
  deleteBatch(db, origin.batch.id);
  const before = snapshot(db);
  const result = await normalizePreviewNames(db, [input(1, '삭제 행 원본', '옵션'),
    input(2, '삭제 작업 원본', '옵션'), input(3, '복제 원본', '옵션')], mock(async request => answer(request)), 'mock');
  assert.ok(result.every(row => row.source === 'ai'));
  assert.equal(calls(db)[0].item_count, 3);
  assert.deepEqual(snapshot(db), before);
});

test('21개 고유 상품은 20개·1개로 호출하며 모든 중복 원본 행을 돌려준다', async t => {
  const db = database(t), before = snapshot(db);
  const inputs = [...Array.from({ length: 21 }, (_, index) => input(index + 1)), input(100, '원본 1')];
  const sizes = [];
  const result = await normalizePreviewNames(db, inputs, mock(async request => {
    sizes.push(JSON.parse(request.input).length); return answer(request);
  }), 'mock');
  assert.deepEqual(sizes, [20, 1]);
  assert.deepEqual(result.map(row => row.id), inputs.map(row => row.id));
  assert.equal(result.at(-1).cleanedName, result[0].cleanedName);
  assert.deepEqual(calls(db).map(row => [row.purpose_code, row.batch_id, row.item_count]),
    [['product_names_preview', null, 20], ['product_names_preview', null, 1]]);
  assert.deepEqual(snapshot(db), before);
});

test('부분 성공 뒤 실패와 재시도는 호출 통계만 남기고 주문·이름 결과는 남기지 않는다', async t => {
  const db = database(t), before = snapshot(db);
  const inputs = Array.from({ length: 21 }, (_, index) => input(index + 1));
  let requests = 0;
  await assert.rejects(normalizePreviewNames(db, inputs, mock(async request => {
    if (++requests === 2) throw Object.assign(new Error('응답 원문은 통계에 저장하지 않음'), { status: 429 });
    return answer(request);
  }), 'mock'), /사용 한도/);
  assert.deepEqual(calls(db).map(row => [row.status, row.item_count]), [['succeeded', 20], ['failed', 1]]);
  assert.equal(calls(db)[1].error_code, '429');
  assert.deepEqual(snapshot(db), before);
  const sizes = [];
  await normalizePreviewNames(db, inputs, mock(async request => {
    sizes.push(JSON.parse(request.input).length); return answer(request);
  }), 'mock');
  assert.deepEqual(sizes, [20, 1]);
  assert.equal(calls(db).length, 4);
  assert.deepEqual(snapshot(db), before);
});

test('거절·불량 응답·ID 누락은 실패 통계로 남기며 다시 정리할 수 있다', async t => {
  const db = database(t), before = snapshot(db);
  for (const action of [
    async () => ({ output: [{ content: [{ type: 'refusal' }] }] }),
    async () => ({ output_text: '{broken' }),
    async request => ({ ...answer(request), output_text: JSON.stringify({ items: [] }) }),
  ]) await assert.rejects(normalizePreviewNames(db, [input(1)], mock(action), 'mock'), /AI/);
  assert.deepEqual(calls(db).map(row => row.status), ['failed', 'failed', 'failed']);
  const result = await normalizePreviewNames(db, [input(1)], mock(async request => answer(request)), 'mock');
  assert.equal(result[0].source, 'ai');
  assert.equal(calls(db).at(-1).status, 'succeeded');
  assert.deepEqual(snapshot(db), before);
});

test('잘못된 입력 전체를 호출 전에 거부하고 빈 목록·키 없는 캐시 미스는 데이터를 쓰지 않는다', async t => {
  const db = database(t), before = snapshot(db);
  const client = mock(async () => { throw new Error('잘못된 입력은 호출되면 안 됩니다.'); });
  for (const inputs of [null, {}, [input(0)], [input(-1)], [input(1.5)], [input(Number.MAX_SAFE_INTEGER + 1)],
    [input(1), input(1)], [input(1), { ...input(2), originalName: ' ' }],
    [{ ...input(1), productName: null }], [{ ...input(1), optionName: 3 }]]) {
    await assert.rejects(normalizePreviewNames(db, inputs, client, 'mock'), /미리보기/);
  }
  assert.deepEqual(await normalizePreviewNames(db, [], null, 'mock'), []);
  await assert.rejects(normalizePreviewNames(db, [input(1)], null, 'mock'), /OPENAI_API_KEY/);
  assert.equal(calls(db).length, 0);
  assert.deepEqual(snapshot(db), before);
});
