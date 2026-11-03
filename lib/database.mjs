import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, file_count INTEGER NOT NULL,
      row_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sheets (
      id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id),
      source_file TEXT NOT NULL, source_sheet TEXT NOT NULL, raw_json TEXT NOT NULL,
      header_index INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_files (
      id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id),
      name TEXT NOT NULL, content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rows (
      id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES batches(id),
      sheet_id INTEGER NOT NULL REFERENCES sheets(id), source_row INTEGER NOT NULL,
      original_name TEXT NOT NULL, product_name TEXT NOT NULL, option_name TEXT NOT NULL,
      generated_name TEXT NOT NULL DEFAULT '', cleaned_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', review_note TEXT NOT NULL DEFAULT '',
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS row_revisions (
      id INTEGER PRIMARY KEY, row_id INTEGER NOT NULL REFERENCES rows(id),
      before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS rows_batch ON rows(batch_id);
    CREATE INDEX IF NOT EXISTS row_revisions_row ON row_revisions(row_id, created_at);
    CREATE INDEX IF NOT EXISTS batches_created_at ON batches(created_at);
    CREATE TABLE IF NOT EXISTS llm_purposes (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY, purpose_code TEXT NOT NULL REFERENCES llm_purposes(code),
      batch_id INTEGER REFERENCES batches(id), model TEXT NOT NULL, item_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL,
      finished_at TEXT, usage_json TEXT, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS llm_calls_started_at ON llm_calls(started_at);
    CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoice_runs (
      id INTEGER PRIMARY KEY, mall TEXT NOT NULL, store TEXT NOT NULL,
      carrier_name TEXT NOT NULL, carrier_code TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
      legacy_signature TEXT NOT NULL, issues_json TEXT NOT NULL DEFAULT '[]',
      scope_json TEXT, generated_at TEXT, generated_file BLOB, generated_filename TEXT, draft_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      status_checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS invoice_files (
      id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES invoice_runs(id),
      kind TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES invoice_runs(id),
      product_order_id TEXT NOT NULL, order_id TEXT NOT NULL, internal_id TEXT NOT NULL DEFAULT '',
      tracking_number TEXT NOT NULL DEFAULT '', expected_json TEXT NOT NULL,
      shipments_json TEXT NOT NULL, source_rows_json TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'hold', note TEXT NOT NULL DEFAULT '',
      registration_state TEXT NOT NULL DEFAULT 'unchecked', status_checked_at TEXT,
      status_json TEXT, UNIQUE(run_id, product_order_id)
    );
    CREATE INDEX IF NOT EXISTS invoice_items_internal ON invoice_items(internal_id);
    CREATE INDEX IF NOT EXISTS invoice_items_product ON invoice_items(product_order_id);
    CREATE TABLE IF NOT EXISTS invoice_revisions (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES invoice_items(id),
      before_json TEXT NOT NULL, after_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS invoice_checks (
      id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES invoice_runs(id),
      started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL DEFAULT 'running',
      results_json TEXT, error TEXT
    );
    INSERT OR IGNORE INTO llm_purposes (code, name) VALUES ('product_names', '상품명 정리');
    INSERT OR IGNORE INTO llm_purposes (code, name) VALUES ('product_names_preview', '신규 주문현황 상품명 정리');
    INSERT OR IGNORE INTO app_metadata (key, value)
      VALUES ('llm_tracking_started_at', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
  const invoiceColumns = new Set(db.prepare('PRAGMA table_info(invoice_runs)').all().map(column => column.name));
  for (const [name, definition] of [['scope_json', 'TEXT'], ['generated_at', 'TEXT'], ['generated_file', 'BLOB'],
    ['generated_filename', 'TEXT'], ['draft_key', "TEXT NOT NULL DEFAULT ''"]]) {
    if (!invoiceColumns.has(name)) db.exec(`ALTER TABLE invoice_runs ADD COLUMN ${name} ${definition}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS invoice_runs_draft ON invoice_runs(draft_key, id)');
  for (const run of db.prepare("SELECT id, mall, store, carrier_code, scope_json FROM invoice_runs WHERE scope_json IS NOT NULL AND draft_key = ''").all()) {
    db.prepare('UPDATE invoice_runs SET draft_key = ? WHERE id = ?').run(
      invoiceDraftKey(db, run.mall, run.store, run.carrier_code, JSON.parse(run.scope_json).batchIds), run.id);
  }
  if (!db.prepare('PRAGMA table_info(sheets)').all().some(column => column.name === 'file_id')) {
    db.exec('ALTER TABLE sheets ADD COLUMN file_id INTEGER REFERENCES source_files(id)');
  }
  for (const table of ['batches', 'rows']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'is_deleted')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`);
    }
  }
  const rowColumns = new Set(db.prepare('PRAGMA table_info(rows)').all().map(column => column.name));
  for (const [name, definition] of [
    ['name_source', "TEXT NOT NULL DEFAULT ''"],
    ['reused_from_row_id', 'INTEGER REFERENCES rows(id)'],
    ['name_updated_at', "TEXT NOT NULL DEFAULT ''"],
    ['naming_version', "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!rowColumns.has(name)) db.exec(`ALTER TABLE rows ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS rows_name_option ON rows(original_name, option_name);
    UPDATE rows SET name_source = CASE WHEN generated_name <> '' THEN 'ai' ELSE 'imported' END
      WHERE name_source = '' AND (generated_name <> '' OR cleaned_name <> '');
    UPDATE rows SET name_updated_at = COALESCE(
      (SELECT MAX(created_at) FROM row_revisions WHERE row_id = rows.id AND
        (json_extract(before_json, '$.cleanedName') IS NOT json_extract(after_json, '$.cleanedName')
         OR json_extract(before_json, '$.status') IS NOT json_extract(after_json, '$.status'))),
      (SELECT created_at FROM batches WHERE id = rows.batch_id))
      WHERE name_updated_at = '' AND cleaned_name <> '';
    CREATE TRIGGER IF NOT EXISTS rows_imported_name AFTER INSERT ON rows
      WHEN NEW.cleaned_name <> '' AND NEW.name_source = '' BEGIN
        UPDATE rows SET name_source = CASE WHEN NEW.generated_name <> '' THEN 'ai' ELSE 'imported' END,
          name_updated_at = (SELECT created_at FROM batches WHERE id = NEW.batch_id) WHERE id = NEW.id;
      END;
    UPDATE llm_calls SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      error_code = 'interrupted' WHERE status = 'running';
  `);
  return db;
}

export function invoiceDraftKey(db, mall, store, carrierCode, batchIds) {
  const dates = [...new Set(batchIds.map(id => db.prepare("SELECT date(created_at, '+9 hours') AS date FROM batches WHERE id = ?").get(id)?.date))].sort();
  return createHash('sha256').update(JSON.stringify([mall, store, carrierCode, dates])).digest('hex');
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listBatches(db, date) {
  let range;
  if (date !== undefined) {
    const midnight = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0000')
      ? new Date(`${date}T00:00:00.000Z`) : new Date(NaN);
    if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) {
      throw new Error('작업 날짜는 실제 존재하는 날짜를 YYYY-MM-DD 형식으로 지정해 주세요.');
    }
    const start = midnight.getTime() - 9 * 60 * 60 * 1000;
    range = [new Date(start).toISOString(), new Date(start + 24 * 60 * 60 * 1000).toISOString()];
  }
  return db.prepare(`SELECT id, name, file_count AS fileCount, row_count AS rowCount,
    created_at AS createdAt FROM batches WHERE is_deleted = 0${range ? ' AND created_at >= ? AND created_at < ?' : ''}
    ORDER BY id DESC`).all(...(range || []));
}

export function batchDetail(db, id, running = false) {
  const batch = db.prepare(`SELECT id, name, file_count AS fileCount, row_count AS rowCount,
    created_at AS createdAt FROM batches WHERE id = ? AND is_deleted = 0`).get(id);
  if (!batch) return null;
  const rows = db.prepare(`SELECT r.id, r.original_name AS originalName,
    r.product_name AS productName, r.option_name AS optionName,
    r.generated_name AS generatedName, r.cleaned_name AS cleanedName,
    r.name_source AS nameSource, r.reused_from_row_id AS reusedFromRowId,
    r.naming_version AS namingVersion,
    r.status, r.review_note AS reviewNote, s.source_file AS sourceFile,
    s.source_sheet AS sourceSheet, r.source_row AS sourceRow
    FROM rows r JOIN sheets s ON s.id = r.sheet_id WHERE r.batch_id = ? AND r.is_deleted = 0 ORDER BY r.id`).all(id);
  const summary = { total: rows.length, pending: 0, review: 0, attention: 0, confirmed: 0 };
  for (const row of rows) summary[row.status]++;
  return { batch: { ...batch, running }, rows, summary };
}

export function deleteBatch(db, id) {
  const result = db.prepare('UPDATE batches SET is_deleted = 1 WHERE id = ? AND is_deleted = 0').run(id);
  if (!result.changes) throw new Error('작업을 찾을 수 없습니다.');
  return { deleted: true };
}

export function deleteRows(db, batchId, rowIds) {
  return transaction(db, () => deleteRowsInTransaction(db, batchId, rowIds));
}

export function deleteRowsInTransaction(db, batchId, rowIds) {
  if (!Array.isArray(rowIds) || !rowIds.length || rowIds.length > 10000
    || rowIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(rowIds).size !== rowIds.length) {
    throw new Error('삭제할 행의 번호가 잘못되었거나 중복되었습니다.');
  }
  const detail = batchDetail(db, batchId);
  if (!detail) throw new Error('작업을 찾을 수 없습니다.');
  const active = new Set(detail.rows.map(row => row.id));
  if (rowIds.some(id => !active.has(id))) throw new Error('현재 작업에 속하지 않거나 이미 삭제된 행이 포함되어 있습니다.');
  const update = db.prepare('UPDATE rows SET is_deleted = 1 WHERE id = ? AND batch_id = ? AND is_deleted = 0');
  for (const id of rowIds) update.run(id, batchId);
  db.prepare('UPDATE batches SET row_count = (SELECT count(*) FROM rows WHERE batch_id = ? AND is_deleted = 0) WHERE id = ?')
    .run(batchId, batchId);
  return batchDetail(db, batchId);
}
