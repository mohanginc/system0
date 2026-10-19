import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { transaction, batchDetail, deleteRowsInTransaction } from './database.mjs';
import { callLlm } from './llm.mjs';

const instructions = readFileSync(new URL('../prompts/product-names.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
export const namingVersion = createHash('sha256').update(instructions).digest('hex');
const schema = {
  type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'cleanedName', 'needsAttention', 'note'], properties: {
        id: { type: 'integer' }, cleanedName: { type: 'string' },
        needsAttention: { type: 'boolean' }, note: { type: 'string' },
      },
    } },
  },
};

export function validateNames(response, expectedIds) {
  if (response.status === 'incomplete' || response.error || response.output?.some(item => item.content?.some(content => content.type === 'refusal'))) {
    throw new Error('AI가 완전한 결과를 반환하지 않았습니다. 저장하지 않은 행은 다시 정리할 수 있습니다.');
  }
  let parsed;
  try { parsed = JSON.parse(response.output_text); }
  catch { throw new Error('AI 응답 형식을 확인할 수 없어 이번 결과를 저장하지 않았습니다. 다시 시도해 주세요.'); }
  const expected = new Set(expectedIds);
  if (!parsed || !Array.isArray(parsed.items) || parsed.items.length !== expected.size) {
    throw new Error('AI 응답에 누락되거나 추가된 상품이 있어 이번 결과를 저장하지 않았습니다.');
  }
  for (const item of parsed.items) {
    if (!Number.isInteger(item.id) || !expected.delete(item.id)
      || typeof item.cleanedName !== 'string' || !item.cleanedName.trim() || item.cleanedName.length > 500
      || typeof item.needsAttention !== 'boolean' || typeof item.note !== 'string' || item.note.length > 1000) {
      throw new Error('AI 응답의 상품 번호 또는 제품명이 올바르지 않아 이번 결과를 저장하지 않았습니다.');
    }
    if (item.needsAttention && !item.note.trim()) throw new Error('AI가 확인 필요 사유를 반환하지 않아 이번 결과를 저장하지 않았습니다.');
  }
  return parsed.items;
}

export function apiError(error) {
  if (error.status === 401) return 'OpenAI API 키를 확인해 주세요. .env 수정 후 서버를 다시 시작해야 합니다.';
  if (error.status === 403) return '현재 API 프로젝트에서 이 모델을 사용할 권한이 없습니다. 모델 및 프로젝트 설정을 확인해 주세요.';
  if (error.status === 429) return 'OpenAI 사용 한도 또는 잔액을 확인한 뒤 다시 시도해 주세요. 이미 저장한 결과는 유지됩니다.';
  if (error.status === 400 || error.status === 404) return 'OpenAI 모델 또는 요청 설정을 확인해 주세요. OPENAI_MODEL 설정을 확인하고 서버를 다시 시작할 수 있습니다.';
  if (error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError') return 'OpenAI 연결에 실패했습니다. 인터넷 연결을 확인한 뒤 남은 행을 다시 정리해 주세요.';
  return 'OpenAI 호출에 실패했습니다. 이미 저장한 결과는 유지되며, 남은 행을 다시 정리할 수 있습니다.';
}

function previousNames(db) {
  return db.prepare(`SELECT r.*, COALESCE(r.reused_from_row_id, r.id) AS origin_id
    FROM rows r JOIN batches b ON b.id = r.batch_id
    JOIN rows origin ON origin.id = COALESCE(r.reused_from_row_id, r.id)
    JOIN batches origin_batch ON origin_batch.id = origin.batch_id
    WHERE r.original_name = ? AND r.option_name = ? AND r.batch_id <> ?
      AND r.is_deleted = 0 AND b.is_deleted = 0 AND origin.is_deleted = 0 AND origin_batch.is_deleted = 0
      AND r.cleaned_name <> '' AND (r.status = 'confirmed'
        OR (r.status IN ('review', 'attention') AND r.generated_name <> ''))
    ORDER BY (r.naming_version = ?) DESC, (r.status = 'confirmed') DESC, r.name_updated_at DESC,
      (SELECT MAX(created_at) FROM row_revisions WHERE row_id = r.id) DESC,
      (r.name_source <> 'reused') DESC, r.id DESC LIMIT 1`);
}

function requestNames(db, purposeCode, batchId, input, client, model) {
  return callLlm(db, { purposeCode, batchId, itemCount: input.length }, {
    responses: { create: async request => {
      try { return await client.responses.create(request); }
      catch (error) { throw Object.assign(new Error(apiError(error)), { code: error.code || error.status || error.name }); }
    } },
  }, {
    model, store: false, instructions, input: JSON.stringify(input),
    max_output_tokens: 6000,
    text: { format: { type: 'json_schema', name: 'product_names', strict: true, schema } },
  }, response => validateNames(response, input.map(row => row.id)));
}

export async function normalizePreviewNames(db, inputs, client, model) {
  if (!Array.isArray(inputs)) throw new Error('미리보기 상품 목록을 확인해 주세요.');
  const ids = new Set(), groups = new Map();
  for (const row of inputs) {
    if (!row || !Number.isSafeInteger(row.id) || row.id < 1 || ids.has(row.id)
      || typeof row.originalName !== 'string' || !row.originalName.trim()
      || typeof row.productName !== 'string' || typeof row.optionName !== 'string') {
      throw new Error('미리보기 상품 번호와 원본 상품명·옵션을 확인해 주세요.');
    }
    ids.add(row.id);
    const input = { id: row.id, originalName: row.originalName, productName: row.productName, optionName: row.optionName };
    const key = JSON.stringify([input.originalName, input.optionName]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(input);
  }
  const previous = previousNames(db), results = new Map(), unique = [];
  for (const rows of groups.values()) {
    const source = previous.get(rows[0].originalName, rows[0].optionName, 0, namingVersion);
    if (!source || source.naming_version !== namingVersion) { unique.push(rows); continue; }
    for (const row of rows) results.set(row.id, { id: row.id, cleanedName: source.cleaned_name,
      needsAttention: source.status === 'attention', note: source.review_note, source: 'reused' });
  }
  if (unique.length && !client) throw new Error('.env에 OPENAI_API_KEY를 설정하고 서버를 다시 시작해 주세요.');
  for (let start = 0; start < unique.length; start += 20) {
    const chunk = unique.slice(start, start + 20);
    const names = await requestNames(db, 'product_names_preview', null, chunk.map(rows => rows[0]), client, model);
    const lookup = new Map(names.map(item => [item.id, item]));
    for (const rows of chunk) {
      const item = lookup.get(rows[0].id);
      for (const row of rows) results.set(row.id, { id: row.id, cleanedName: item.cleanedName.trim(),
        needsAttention: item.needsAttention, note: item.note.trim(), source: 'ai' });
    }
  }
  return inputs.map(row => results.get(row.id));
}

export async function normalizeBatch(db, batchId, client, model, rowIds) {
  const detail = batchDetail(db, batchId);
  if (!detail) throw new Error('작업을 찾을 수 없습니다.');
  if (rowIds !== undefined && (!Array.isArray(rowIds) || !rowIds.length || rowIds.some(id => !Number.isInteger(id)) || new Set(rowIds).size !== rowIds.length)) {
    throw new Error('정리할 행의 번호를 확인해 주세요.');
  }
  const selected = rowIds === undefined ? null : new Set(rowIds);
  if (selected && detail.rows.filter(row => selected.has(row.id)).length !== selected.size) throw new Error('선택한 행이 현재 작업에 속하지 않습니다.');
  const candidates = detail.rows.filter(row => row.status === 'pending' && !row.cleanedName.trim() && !row.generatedName.trim() && (!selected || selected.has(row.id)));
  if (!candidates.length) return detail;
  const groups = new Map();
  for (const row of candidates) {
    const key = JSON.stringify([row.originalName, row.optionName]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const previous = previousNames(db);
  const unique = [];
  transaction(db, () => {
    const reuse = db.prepare(`UPDATE rows SET generated_name = ?, cleaned_name = ?, status = ?, review_note = ?,
      name_source = 'reused', reused_from_row_id = ?, name_updated_at = ?, naming_version = ?
      WHERE id = ? AND batch_id = ? AND is_deleted = 0 AND status = 'pending'
        AND cleaned_name = '' AND generated_name = ''
        AND EXISTS (SELECT 1 FROM batches WHERE id = rows.batch_id AND is_deleted = 0)`);
    for (const rows of groups.values()) {
      const source = previous.get(rows[0].originalName, rows[0].optionName, batchId, namingVersion);
      if (!source || source.naming_version !== namingVersion) { unique.push({ rows, source }); continue; }
      for (const row of rows) reuse.run(source.generated_name, source.cleaned_name, source.status, source.review_note,
        source.origin_id, source.name_updated_at, namingVersion, row.id, batchId);
    }
  });
  if (unique.length && !client) throw new Error('.env에 OPENAI_API_KEY를 설정하고 서버를 다시 시작해 주세요.');
  for (let start = 0; start < unique.length; start += 20) {
    const chunk = unique.slice(start, start + 20);
    const input = chunk.map(({ rows: [row], source }) => ({ id: row.id, originalName: row.originalName,
      productName: row.productName, optionName: row.optionName,
      ...(source ? { previousName: source.cleaned_name, previousReviewNote: source.review_note } : {}) }));
    const results = await requestNames(db, 'product_names', batchId, input, client, model);
    const lookup = new Map(results.map(item => [item.id, item]));
    transaction(db, () => {
      const update = db.prepare(`UPDATE rows SET generated_name = ?, cleaned_name = ?, status = ?, review_note = ?,
        name_source = 'ai', reused_from_row_id = NULL, name_updated_at = ?, naming_version = ?
        WHERE id = ? AND batch_id = ? AND is_deleted = 0 AND status = 'pending' AND cleaned_name = '' AND generated_name = ''
        AND EXISTS (SELECT 1 FROM batches WHERE id = rows.batch_id AND is_deleted = 0)`);
      for (const { rows } of chunk) {
        const result = lookup.get(rows[0].id);
        for (const row of rows) update.run(result.cleanedName.trim(), result.cleanedName.trim(),
          result.needsAttention ? 'attention' : 'review', result.note.trim(), new Date().toISOString(), namingVersion, row.id, batchId);
      }
    });
  }
  return batchDetail(db, batchId);
}

export function reviseRows(db, batchId, changes, deletedRowIds = []) {
  return transaction(db, () => {
    const detail = batchDetail(db, batchId);
    if (!detail) throw new Error('작업을 찾을 수 없습니다.');
    if (!Array.isArray(changes) || changes.length > 10000 || !Array.isArray(deletedRowIds)
      || (!changes.length && !deletedRowIds.length)) throw new Error('저장할 변경 내용을 확인해 주세요.');
    const existing = new Map(detail.rows.map(row => [row.id, row]));
    const deleting = new Set(deletedRowIds), seen = new Set();
    const prepared = changes.map(change => {
      const row = existing.get(change?.id);
      if (!row || seen.has(change.id)) throw new Error('변경할 행의 번호가 잘못되었거나 중복되었습니다.');
      if (deleting.has(change.id)) throw new Error('같은 행을 수정하면서 삭제할 수 없습니다.');
      seen.add(change.id);
      if (typeof change.cleanedName !== 'string' || change.cleanedName.length > 500
        || typeof change.reviewNote !== 'string' || change.reviewNote.length > 1000
        || !['pending', 'review', 'attention', 'confirmed'].includes(change.status)) throw new Error('제품명, 검수 메모 또는 상태를 확인해 주세요.');
      const cleanedName = change.cleanedName.trim();
      if (change.status !== 'pending' && !cleanedName) throw new Error('제품명이 비어 있는 행은 검수 상태로 저장할 수 없습니다.');
      if (change.status === 'pending' && cleanedName) throw new Error('직접 입력한 제품명은 검수 대기 또는 검수 완료로 저장해 주세요.');
      if (change.status === 'pending' && row.generatedName) throw new Error('AI가 만든 제품명은 비우지 말고 수정한 뒤 검수해 주세요.');
      return { before: row, after: { cleanedName, reviewNote: change.reviewNote.trim(), status: change.status } };
    });
    if (deletedRowIds.length) deleteRowsInTransaction(db, batchId, deletedRowIds);
    const update = db.prepare(`UPDATE rows SET cleaned_name = ?, review_note = ?, status = ?,
      name_source = CASE WHEN name_source = '' AND ? <> '' THEN 'manual' ELSE name_source END,
      naming_version = CASE WHEN name_source = '' AND ? <> '' THEN ? ELSE naming_version END,
      name_updated_at = CASE WHEN cleaned_name <> ? OR status <> ? THEN ? ELSE name_updated_at END
      WHERE id = ? AND batch_id = ? AND is_deleted = 0
      AND EXISTS (SELECT 1 FROM batches WHERE id = rows.batch_id AND is_deleted = 0)`);
    const revision = db.prepare('INSERT INTO row_revisions (row_id, before_json, after_json) VALUES (?, ?, ?)');
    for (const { before, after } of prepared) {
      const previous = { cleanedName: before.cleanedName, reviewNote: before.reviewNote, status: before.status };
      if (JSON.stringify(previous) === JSON.stringify(after)) continue;
      revision.run(before.id, JSON.stringify(previous), JSON.stringify(after));
      if (!update.run(after.cleanedName, after.reviewNote, after.status, after.cleanedName, after.cleanedName, namingVersion,
        after.cleanedName, after.status, new Date().toISOString(), before.id, batchId).changes) {
        throw new Error('작업 또는 행이 삭제되어 변경 내용을 저장할 수 없습니다.');
      }
    }
    return batchDetail(db, batchId);
  });
}
