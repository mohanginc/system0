import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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
    CREATE INDEX IF NOT EXISTS batches_created_at ON batches(created_at);
  `);
  if (!db.prepare('PRAGMA table_info(sheets)').all().some(column => column.name === 'file_id')) {
    db.exec('ALTER TABLE sheets ADD COLUMN file_id INTEGER REFERENCES source_files(id)');
  }
  for (const table of ['batches', 'rows']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'is_deleted')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`);
    }
  }
  return db;
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
