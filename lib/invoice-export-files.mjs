import { createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { invoiceView, invoiceWorkbook, warningNeedsItemReview } from './invoices.mjs';

const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function fileMetadata(record) {
  return { id: record.id, mode: record.mode, sha256: record.sha256,
    filename: `네이버_발송처리_${record.mode === 'pending' ? '미등록추가' : '전체확인'}_${record.id}.xlsx`,
    productOrderIds: JSON.parse(record.product_order_ids_json), createdAt: record.created_at };
}

function exportSkip(item, mode, issues) {
  if (item.superseded) return ['superseded', '같은 상품주문의 최신 송장 작업에서 처리해 주세요.'];
  if (item.decision === 'exclude') return ['excluded', '송장 작업에서 제외한 상품주문입니다.'];
  if (item.registrationState === 'conflict') return ['registration_conflict', item.registrationNote || '네이버 등록 상태가 현재 매칭과 다릅니다.'];
  if (item.decision !== 'include') return ['hold', '송장 검토에서 보류한 상품주문입니다.'];
  if (!item.trackingNumber || !item.sourceRows.length) return ['blocked', '송장과 저장 주문의 연결을 먼저 확정해 주세요.'];
  if (mode === 'pending') {
    if (item.sourceRegistered || item.statusFresh && (item.registrationState === 'complete' || item.naverRegistration?.matches === true)) {
      return ['registered', '같은 송장이 네이버에 등록된 상품주문입니다.'];
    }
    if (!item.statusFresh || item.registrationState !== 'pending' || item.naverRegistration?.status !== 'PAYED'
      || item.naverRegistration.trackingNumber !== '') {
      return ['registration_unchecked', '네이버 등록 상태를 조회해 발송대기와 미등록 여부를 확인해 주세요.'];
    }
  }
  const warning = item.issues.map(key => issues.get(key)).find(value => value?.reviewRequired && warningNeedsItemReview(value, item));
  return warning ? ['blocked', warning.message] : null;
}

export function listInvoiceExportFiles(db, id) {
  return db.prepare(`SELECT id, mode, sha256, product_order_ids_json, created_at
    FROM invoice_export_files WHERE run_id = ? ORDER BY id DESC`).all(id).map(fileMetadata);
}

export function downloadInvoiceExportFile(db, id, fileId) {
  const file = db.prepare('SELECT * FROM invoice_export_files WHERE run_id = ? AND id = ?').get(id, fileId);
  if (!file) throw Object.assign(new Error('보관된 추가 엑셀을 찾을 수 없습니다.'), { status: 404, code: 'invoice_export_not_found' });
  return { buffer: Buffer.from(file.content), filename: fileMetadata(file).filename, contentType };
}

export function createInvoiceExportFile(db, id, { expectedVersion, productOrderIds, mode, validateOnly = false } = {}) {
  if (!['pending', 'all'].includes(mode) || typeof validateOnly !== 'boolean'
    || typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion)
    || productOrderIds !== null && (mode !== 'pending' || !Array.isArray(productOrderIds)
      || !productOrderIds.length || productOrderIds.length > 1000
      || productOrderIds.some(value => typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value)
      || new Set(productOrderIds).size !== productOrderIds.length)) {
    throw new Error('엑셀 범위와 중복 없는 상품주문번호, 현재 검토 버전을 확인해 주세요.');
  }
  const prepare = () => {
    const view = invoiceView(db, id);
    if (view.viewVersion !== expectedVersion) throw Object.assign(new Error('송장 작업이 바뀌었습니다. 최신 검토 내역으로 다시 만들어 주세요.'),
      { status: 409, code: 'stale_invoice_version' });
    if (view.scopeRequired || view.rematchRequired) throw new Error('저장 출고 작업을 확인하고 송장을 다시 매칭해 주세요.');
    const selected = productOrderIds === null ? null : new Set(productOrderIds);
    const issues = new Map(view.issues.map(issue => [issue.key, issue]));
    const included = [], skipped = [];
    for (const item of view.items) {
      if (selected && !selected.delete(item.productOrderId)) continue;
      const reason = exportSkip(item, mode, issues);
      if (reason) skipped.push({ productOrderId: item.productOrderId, code: reason[0], reason: reason[1] });
      else included.push({ productOrderId: item.productOrderId, trackingNumber: item.trackingNumber });
    }
    for (const productOrderId of selected || []) {
      skipped.push({ productOrderId, code: 'not_found', reason: '이 송장 작업에서 찾을 수 없는 상품주문입니다.' });
    }
    const result = { file: null, included, skipped, viewVersion: view.viewVersion };
    if (validateOnly || !included.length) return result;
    const buffer = invoiceWorkbook(included, view.run.carrierName);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    db.prepare(`INSERT INTO invoice_export_files (run_id, mode, product_order_ids_json, sha256, content) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (run_id, mode, sha256) DO NOTHING`).run(id, mode, JSON.stringify(included.map(item => item.productOrderId)), sha256, buffer);
    const file = db.prepare(`SELECT id, mode, sha256, product_order_ids_json, created_at FROM invoice_export_files
      WHERE run_id = ? AND mode = ? AND sha256 = ?`).get(id, mode, sha256);
    return { ...result, file: fileMetadata(file) };
  };
  return validateOnly ? prepare() : transaction(db, prepare);
}
