import path from 'node:path';
import * as XLSX from 'xlsx';
import { zipSync } from 'fflate';
import { transaction, batchDetail } from './database.mjs';

const headers = {
  name: ['원상품명', '제품명원본', '상품명'],
  option: ['옵션명', '상품옵션', '주문옵션', '선택옵션', '옵션정보', '옵션'],
  cleaned: ['정리된제품명'],
  note: ['검수메모', '검수의견'],
  status: ['검수상태'],
};
const cellText = value => value == null ? '' : String(value);
const nonempty = row => row.some(value => value != null && cellText(value).trim() !== '');
const headerText = value => cellText(value).replace(/\s/g, '');

export function splitTitle(originalName, separateOption = '') {
  const marker = originalName.indexOf('제품선택');
  const productName = (marker < 0 ? originalName : originalName.slice(0, marker))
    .trim().replace(/[\s/:：=\[]+$/, '');
  const embedded = marker < 0 ? '' : originalName.slice(marker + '제품선택'.length)
    .replace(/^[\s\]:：=/]+/, '').trim();
  const optionName = [embedded, separateOption.trim()].filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index).join(' / ');
  return { productName, optionName };
}

function columnIndex(row, candidates) {
  for (const candidate of candidates) {
    const index = row.findIndex(value => headerText(value) === candidate);
    if (index >= 0) return index;
  }
  return -1;
}

export function parseFiles(files) {
  if (!files.length) throw new Error('엑셀 파일을 선택해 주세요.');
  const sheets = [];
  for (const [fileIndex, file] of files.entries()) {
    const filename = path.basename(file.originalname);
    const sheetCountBefore = sheets.length;
    if (!/\.xlsx?$/i.test(filename)) throw new Error(`${filename}: .xls 또는 .xlsx 파일만 올릴 수 있습니다.`);
    let workbook;
    try { workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: false }); }
    catch { throw new Error(`${filename}: 엑셀을 읽을 수 없습니다. 파일 형식을 확인해 주세요.`); }
    for (const sheetName of workbook.SheetNames) {
      const source = workbook.Sheets[sheetName];
      if (!source['!ref']) continue;
      const range = { s: { r: 0, c: 0 }, e: XLSX.utils.decode_range(source['!ref']).e };
      const raw = XLSX.utils.sheet_to_json(source, { header: 1, defval: null, raw: true, blankrows: true, range });
      if (!raw.some(nonempty)) continue;
      let headerIndex = raw.slice(0, 20).findIndex(row => columnIndex(row, headers.name) >= 0);
      const headerless = headerIndex < 0 && /^제품명_옵션명_연결(?:_.*)?\.xlsx$/i.test(filename)
        && raw.every(row => row.length <= 3);
      if (headerIndex < 0 && !headerless) {
        continue; // 보조 시트는 원본에 남겨 두고 상품명 컬럼이 있는 시트만 처리한다.
      }
      const header = headerless ? [] : raw[headerIndex];
      const nameIndex = headerless ? 0 : columnIndex(header, headers.name);
      const optionIndex = headerless ? -1 : columnIndex(header, headers.option);
      const cleanedIndex = headerless ? 1 : columnIndex(header, headers.cleaned);
      const noteIndex = headerless ? 2 : columnIndex(header, headers.note);
      const statusIndex = headerless ? -1 : columnIndex(header, headers.status);
      const rows = [];
      for (let index = headerIndex + 1; index < raw.length; index++) {
        const cells = raw[index];
        if (!nonempty(cells)) continue;
        const originalName = cellText(cells[nameIndex]);
        if (!originalName.trim()) throw new Error(`${filename} / ${sheetName} / ${index + 1}행: 상품명이 비어 있어 가져오기를 중단했습니다.`);
        const { productName, optionName } = splitTitle(originalName, optionIndex < 0 ? '' : cellText(cells[optionIndex]));
        const cleanedName = cleanedIndex < 0 ? '' : cellText(cells[cleanedIndex]).trim();
        const importedStatus = statusIndex < 0 ? '' : cellText(cells[statusIndex]).trim();
        const staffExamples = headerless && filename === '제품명_옵션명_연결.xlsx';
        const status = !cleanedName ? 'pending'
          : staffExamples || ['confirmed', '검수 완료', '검수완료'].includes(importedStatus) ? 'confirmed'
            : ['attention', '확인 필요', '확인필요'].includes(importedStatus) ? 'attention' : 'review';
        rows.push({ sourceRow: index + 1, originalName, productName, optionName, cleanedName,
          reviewNote: noteIndex < 0 ? '' : cellText(cells[noteIndex]), status });
      }
      if (rows.length) sheets.push({ fileIndex, sourceFile: filename, sourceSheet: sheetName, raw, headerIndex, rows });
    }
    if (sheets.length === sheetCountBefore) throw new Error(`${filename}: 원상품명, 제품명 원본 또는 상품명 컬럼을 찾을 수 없거나 가져올 상품 행이 없습니다.`);
  }
  if (!sheets.length) throw new Error('가져올 상품 행이 없습니다.');
  return sheets;
}

export function importFiles(db, files) {
  const sheets = parseFiles(files);
  return transaction(db, () => {
    const count = sheets.reduce((total, sheet) => total + sheet.rows.length, 0);
    const name = files.length === 1 ? path.basename(files[0].originalname) : `${path.basename(files[0].originalname)} 외 ${files.length - 1}개`;
    const batchId = Number(db.prepare('INSERT INTO batches (name, file_count, row_count) VALUES (?, ?, ?)')
      .run(name, files.length, count).lastInsertRowid);
    const addFile = db.prepare('INSERT INTO source_files (batch_id, name, content) VALUES (?, ?, ?)');
    const fileIds = files.map(file => Number(addFile.run(batchId, path.basename(file.originalname), file.buffer).lastInsertRowid));
    const addSheet = db.prepare('INSERT INTO sheets (batch_id, source_file, source_sheet, raw_json, header_index, file_id) VALUES (?, ?, ?, ?, ?, ?)');
    const addRow = db.prepare(`INSERT INTO rows (batch_id, sheet_id, source_row, original_name, product_name,
      option_name, cleaned_name, status, review_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const sheet of sheets) {
      const sheetId = Number(addSheet.run(batchId, sheet.sourceFile, sheet.sourceSheet, JSON.stringify(sheet.raw), sheet.headerIndex, fileIds[sheet.fileIndex]).lastInsertRowid);
      for (const row of sheet.rows) addRow.run(batchId, sheetId, row.sourceRow, row.originalName,
        row.productName, row.optionName, row.cleanedName, row.status, row.reviewNote);
    }
    return batchDetail(db, batchId);
  });
}

const statusLabel = { pending: '미처리', review: '검수 대기', attention: '확인 필요', confirmed: '검수 완료' };

function removeWorksheetRows(sheet, sourceRows) {
  const removed = sourceRows.map(row => row - 1).sort((a, b) => a - b);
  const deleted = new Set(removed);
  const shift = row => row - removed.filter(value => value < row).length;
  const moveRange = range => {
    let start = range.s.r, end = range.e.r;
    while (start <= end && deleted.has(start)) start++;
    while (end >= start && deleted.has(end)) end--;
    return start > end ? null : { s: { ...range.s, r: shift(start) }, e: { ...range.e, r: shift(end) } };
  };
  const cells = Object.entries(sheet).filter(([address]) => !address.startsWith('!'));
  for (const [address] of cells) delete sheet[address];
  for (const [address, cell] of cells) {
    const position = XLSX.utils.decode_cell(address);
    if (!deleted.has(position.r)) sheet[XLSX.utils.encode_cell({ ...position, r: shift(position.r) })] = cell;
  }
  if (sheet['!ref']) {
    const range = moveRange(XLSX.utils.decode_range(sheet['!ref']));
    if (range) sheet['!ref'] = XLSX.utils.encode_range(range);
    else delete sheet['!ref'];
  }
  if (sheet['!rows']) for (const row of [...removed].reverse()) sheet['!rows'].splice(row, 1);
  if (sheet['!merges']) sheet['!merges'] = sheet['!merges'].map(moveRange)
    .filter(range => range && (range.s.r !== range.e.r || range.s.c !== range.e.c));
  if (sheet['!autofilter']) {
    const range = moveRange(XLSX.utils.decode_range(sheet['!autofilter'].ref));
    if (range) sheet['!autofilter'].ref = XLSX.utils.encode_range(range);
    else delete sheet['!autofilter'];
  }
}

function replaceWorkbook(buffer, replacements, deletions) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: true, cellStyles: true });
  if ([...deletions.values()].some(rows => rows.length)
    && (workbook.Workbook?.Names?.some(name => name.Name !== '_xlnm._FilterDatabase'
      || !workbook.Sheets[workbook.SheetNames[name.Sheet]]?.['!autofilter']) || Object.values(workbook.Sheets)
      .some(sheet => Object.values(sheet).some(cell => (cell?.f && !/^[0-9\s.+*/^()%\-]+$/.test(cell.f))
        || cell?.F || cell?.l?.Target?.startsWith('#'))))) {
    throw new Error('행을 삭제한 원본 파일에 참조 수식·배열 수식·이름 정의·내부 링크가 있어 주문 파일을 안전하게 만들 수 없습니다. 상품명 목록을 내려받거나, 원본에서 해당 참조를 제거한 파일을 다시 불러와 주세요.');
  }
  for (const replacement of replacements) {
    const address = XLSX.utils.encode_cell({ r: replacement.row - 1, c: replacement.column - 1 });
    const cell = workbook.Sheets[replacement.sheetName]?.[address];
    if (!cell || String(cell.v ?? '') !== replacement.originalName) {
      throw new Error('상품명 셀 값이 가져온 원본과 일치하지 않아 내보내기를 중단했습니다.');
    }
    cell.t = 's';
    cell.v = replacement.cleanedName;
    delete cell.w;
    delete cell.r;
    delete cell.h;
    delete cell.f;
  }
  for (const [sheetName, sourceRows] of deletions) {
    if (sourceRows.length) removeWorksheetRows(workbook.Sheets[sheetName], sourceRows);
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

export async function exportDownload(db, batchId, kind = 'orders') {
  const detail = batchDetail(db, batchId);
  if (!detail) throw new Error('작업을 찾을 수 없습니다.');
  if (!detail.rows.length) throw new Error('남아 있는 주문 행이 없어 내려받을 수 없습니다.');
  if (!detail.rows.every(row => row.cleanedName.trim())) throw new Error('정리된 제품명이 비어 있는 행이 있습니다. 먼저 정리하거나 직접 입력해 주세요.');
  if (!['orders', 'names'].includes(kind)) throw new Error('내보내기 종류를 확인해 주세요.');
  if (kind === 'names') {
    const workbook = XLSX.utils.book_new();
    const unique = new Map();
    for (const row of detail.rows) {
      const key = JSON.stringify([row.originalName, row.optionName, row.cleanedName, row.status, row.reviewNote]);
      if (!unique.has(key)) unique.set(key, row);
    }
    const data = [['제품명 원본', '정리된 제품명', '옵션명', '검수상태', '검수메모'],
      ...[...unique.values()].map(row => [row.originalName, row.cleanedName, row.optionName, statusLabel[row.status], row.reviewNote])];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), '제품명 정리');
    return { buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), filename: '상품명목록.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  const sheets = db.prepare('SELECT * FROM sheets WHERE batch_id = ? ORDER BY id').all(batchId);
  const files = db.prepare('SELECT * FROM source_files WHERE batch_id = ? ORDER BY id').all(batchId);
  if (sheets.some(sheet => !sheet.file_id) || files.length !== detail.batch.fileCount) {
    throw new Error('이전 작업에는 원본 파일이 저장되어 있지 않습니다. 주문 파일을 내려받으려면 파일을 다시 불러와 주세요. 상품명 목록은 내려받을 수 있습니다.');
  }
  const rows = db.prepare('SELECT sheet_id, source_row, original_name, cleaned_name, is_deleted FROM rows WHERE batch_id = ? ORDER BY id').all(batchId);
  const outputs = [];
  const usedNames = new Set();
  for (const file of files) {
    const fileSheets = sheets.filter(sheet => sheet.file_id === file.id);
    const replacements = fileSheets.flatMap(sheet => {
      const raw = JSON.parse(sheet.raw_json);
      const column = sheet.header_index < 0 ? 0 : columnIndex(raw[sheet.header_index], headers.name);
      if (column < 0) throw new Error('원본 상품명 컬럼을 찾을 수 없습니다.');
      return rows.filter(row => row.sheet_id === sheet.id && !row.is_deleted).map(row => ({ sheetName: sheet.source_sheet,
        row: row.source_row, column: column + 1, originalName: row.original_name, cleanedName: row.cleaned_name }));
    });
    if (!replacements.length) continue;
    const deletions = new Map(fileSheets.map(sheet => [sheet.source_sheet,
      rows.filter(row => row.sheet_id === sheet.id && row.is_deleted).map(row => row.source_row)]));
    const base = path.basename(file.name, path.extname(file.name));
    let filename = `${base}_상품명정리.xlsx`;
    for (let suffix = 2; usedNames.has(filename.toLowerCase()); suffix++) filename = `${base}_상품명정리_${suffix}.xlsx`;
    usedNames.add(filename.toLowerCase());
    outputs.push({ filename, buffer: replaceWorkbook(Buffer.from(file.content), replacements, deletions) });
  }
  if (detail.batch.fileCount === 1) return { ...outputs[0], contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  return { filename: `주문_상품명정리_${batchId}.zip`, contentType: 'application/zip',
    buffer: Buffer.from(zipSync(Object.fromEntries(outputs.map(output => [output.filename, output.buffer])))) };
}

export async function exportWorkbook(db, batchId, kind) {
  return (await exportDownload(db, batchId, kind)).buffer;
}
