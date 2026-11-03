import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import officeCrypto from 'officecrypto-tool';
import { transaction } from './database.mjs';

export const CARRIERS = [
  { code: 'KGB', name: '로젠택배' }, { code: 'CJGLS', name: 'CJ대한통운' },
  { code: 'HANJIN', name: '한진택배' }, { code: 'HYUNDAI', name: '롯데택배' }, { code: 'EPOST', name: '우체국택배' },
];
const text = value => value == null ? '' : String(value).trim();
const compact = value => text(value).normalize('NFC').replace(/\s/g, '');
const phone = value => text(value).replace(/[^0-9*]/g, '');
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const idText = value => typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 ? String(value) : ''
  : typeof value === 'string' && /^[\w-]+$/.test(value.trim()) && !/^\d+[eE][+-]?\d+$/.test(value.trim()) ? value.trim() : '';
const integer = value => (typeof value === 'number' || /^\d+$/.test(text(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const issue = (issues, kind, message, extra = {}) => {
  const key = hash([kind, extra.productOrderId || '', extra.internalId || '', extra.source || '']).slice(0, 24);
  if (!issues.some(item => item.key === key)) issues.push({ key, kind, message, blocking: false, resolved: false, note: '', ...extra });
};
const columns = row => names => names.map(name => row.findIndex(cell => compact(cell) === name)).find(index => index >= 0) ?? -1;
const registeredStatuses = new Set(['DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', '배송중', '배송완료', '구매확정']);
const canceled = value => /^(CANCELED|CANCELLED|RETURNED|취소|취소완료|반품완료)$/.test(compact(value));
const matchingVersion = 'final-naver-all-dates-v3';
const sourceDay = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
class InvoiceStatusError extends Error {}

function courierIdReason(parcel) {
  const problems = [['주문번호', parcel.originalInternalId, parcel.internalId],
    ['송장번호', parcel.originalTrackingNumberValue, parcel.trackingNumber]].filter(([, , valid]) => !valid);
  const parts = problems.map(([label, original], index) => label + '가 ' + (text(original)
    ? index === problems.length - 1 ? '유효하지 않아' : '유효하지 않고'
    : index === problems.length - 1 ? '비어 있어' : '비어 있고'));
  return '택배사 파일의 ' + parts.join(' ') + ' 확인한 주문에 연결하지 못했습니다.';
}

export async function unlockNaverFiles(files, password = '') {
  if (typeof password !== 'string' || password.length > 255) throw new Error('네이버 파일 암호는 255자 이내로 입력해 주세요.');
  const prepared = [];
  for (const file of files) {
    let encrypted = false;
    try { encrypted = officeCrypto.isEncrypted(file.buffer); } catch { /* 손상된 파일은 기존 엑셀 읽기에서 안내합니다. */ }
    if (!encrypted) { prepared.push(file); continue; }
    const label = `① 네이버 주문파일 ‘${path.basename(file.originalname || file.name || '')}’`;
    if (!password) throw new Error(`${label}에 암호가 설정되어 있습니다. 네이버 파일 암호를 입력해 주세요.`);
    try { prepared.push({ ...file, readBuffer: await officeCrypto.decrypt(file.buffer, { password }) }); }
    catch { throw new Error(`${label}의 암호를 해제하지 못했습니다. 입력한 파일 암호가 맞는지 확인해 주세요.`); }
  }
  return prepared;
}

function inputFiles(files, kind) {
  if (!Array.isArray(files) || !files.length) throw new Error(kind === 'naver' ? '네이버 주문 원본 파일을 선택해 주세요.' : '택배사 송장 파일을 선택해 주세요.');
  const unique = new Map();
  for (const file of files) {
    const name = path.basename(file.originalname || file.name || '');
    if (!/\.xlsx?$/i.test(name) || !file.buffer?.length) throw new Error('내용이 있는 .xls 또는 .xlsx 파일을 선택해 주세요.');
    const buffer = Buffer.from(file.buffer), sha256 = hash(buffer);
    if (!unique.has(sha256)) unique.set(sha256, { kind, name, buffer, sha256, readBuffer: file.readBuffer });
  }
  return [...unique.values()];
}

function parseInputs(files, issues) {
  const products = new Map(), parcels = [];
  const rowCounts = { naver: 0, courier: 0 };
  for (const file of files) {
    let workbook;
    try { workbook = XLSX.read(file.readBuffer || file.buffer, { type: 'buffer', cellDates: false }); }
    catch (error) {
      const label = file.kind === 'naver' ? '① 네이버 주문파일' : '③ 택배사 송장파일';
      if (/password|encrypt/i.test(error.message)) {
        throw new Error(`${label} ‘${file.name}’에 암호가 설정되어 있습니다. ${file.kind === 'naver' ? '네이버 파일 암호를 입력해 주세요.' : '엑셀에서 암호를 해제한 복사본을 저장해 업로드해 주세요.'}`);
      }
      throw new Error(`${label} ‘${file.name}’을 읽을 수 없습니다. 엑셀에서 파일이 정상적으로 열리는지 확인해 주세요.`);
    }
    let found = false;
    for (const sheetName of workbook.SheetNames) {
      const raw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: true });
      const headerIndex = raw.slice(0, 20).findIndex(row => {
        const col = columns(row);
        return col(['주문번호']) >= 0 && col(file.kind === 'naver' ? ['상품주문번호'] : ['운송장번호', '송장번호']) >= 0;
      });
      if (headerIndex < 0) continue;
      found = true;
      const col = columns(raw[headerIndex]), order = col(['주문번호']);
      const number = col(file.kind === 'naver' ? ['상품주문번호'] : ['운송장번호', '송장번호']);
      for (let r = headerIndex + 1; r < raw.length; r++) {
        const cells = raw[r], productName = text(cells[col(file.kind === 'naver' ? ['상품명'] : ['물품명', '상품명'])]);
        if (compact(cells[number]) === compact(raw[headerIndex][number])) continue;
        if (!text(cells[number]) && !text(cells[order]) && !productName
          && !text(cells[col(['수취인명', '수취인', '받는분', '이름', '수하인'])])
          && !text(cells[col(['수취인연락처1', '연락처1', '전화번호', '전화'])])
          && !text(cells[col(['통합배송지', '수취인전체주소', '주소', '배송지주소'])])) continue;
        rowCounts[file.kind]++;
        const source = { sourceFile: file.name, sourceSheet: sheetName, sourceRow: r + 1, fileHash: file.sha256 };
        const orderId = idText(cells[order]), numberId = idText(cells[number]);
        if (!orderId || !numberId) {
          const message = file.kind === 'courier' ? courierIdReason({ internalId: orderId, trackingNumber: numberId,
            originalInternalId: text(cells[order]), originalTrackingNumberValue: text(cells[number]) })
            : '번호가 비어 있거나 숫자 정밀도를 확인할 수 없는 행이 있어 자동 연결하지 않았습니다.';
          issue(issues, 'invalid_' + file.kind + '_id', message,
            { source, ...(file.kind === 'courier' && orderId ? { internalId: orderId } : {}) });
          if (file.kind === 'naver') continue;
        }
        if (file.kind === 'naver') {
          const quantity = integer(cells[col(['수량'])]);
          if (quantity === null || quantity < 1) throw new Error('네이버 주문 원본의 상품 수량을 확인해 주세요.');
          const record = { productOrderId: numberId, orderId, quantity, productName, optionName: text(cells[col(['옵션정보', '옵션'])]),
            recipient: text(cells[col(['수취인명', '수취인', '받는분'])]), phone: text(cells[col(['수취인연락처1', '연락처1', '전화번호'])]),
            address: text(cells[col(['통합배송지', '수취인전체주소', '주소', '배송지주소'])]),
            status: text(cells[col(['주문상태'])]), detailStatus: text(cells[col(['주문세부상태'])]),
            sourceTrackingNumber: idText(cells[col(['송장번호', '운송장번호'])]),
            sourceCarrier: text(cells[col(['택배사'])]), sources: [source] };
          const prior = products.get(numberId);
          if (prior) {
            const comparable = item => JSON.stringify({ ...item, sources: [] });
            if (comparable(prior) !== comparable(record)) issue(issues, 'naver_conflict', '같은 상품주문번호의 네이버 원본 내용이 서로 다릅니다.', { productOrderId: numberId, blocking: true });
            prior.sources.push(source);
          } else products.set(numberId, record);
        } else {
          const roundValue = cells[col(['차수'])], issued = integer(cells[col(['발행횟수'])]);
          const printValue = cells[col(['출력시간'])];
          const printedAt = typeof printValue === 'number' && XLSX.SSF.parse_date_code(printValue)
            ? (() => { const d = XLSX.SSF.parse_date_code(printValue); return printValue < 1
              ? [d.H, d.M, d.S].map(value => String(value).padStart(2, '0')).join(':')
              : new Date(Date.UTC(d.y, d.m - 1, d.d, d.H, d.M, d.S)).toISOString(); })()
            : text(printValue);
          parcels.push({ internalId: orderId, trackingNumber: numberId, validIds: Boolean(orderId && numberId),
            originalInternalId: text(cells[order]), originalTrackingNumberValue: text(cells[number]), round: text(roundValue),
            originalTrackingNumber: idText(cells[col(['원송장번호'])]), issueCount: issued, printedAt,
            recipient: text(cells[col(['수취인명', '이름', '수하인'])]), phone: text(cells[col(['전화', '전화번호'])]),
            address: text(cells[col(['주소'])]), source });
        }
      }
    }
    if (!found) throw new Error(file.kind === 'naver' ? '네이버 원본의 상품주문번호·주문번호 컬럼을 찾을 수 없습니다.' : '택배사 원본의 운송장번호·주문번호 컬럼을 찾을 수 없습니다.');
  }
  if (files.some(file => file.kind === 'naver') && !rowCounts.naver) throw new Error('네이버 주문 원본에 상품주문 행이 없습니다.');
  if (files.some(file => file.kind === 'courier') && !rowCounts.courier) throw new Error('택배사 송장 파일에 주문 행이 없습니다.');
  return { products: [...products.values()], parcels };
}

function legacyRows(db, { batchIds, rowIds, includeDeleted = false } = {}) {
  const rows = db.prepare(`SELECT r.id, r.batch_id, r.sheet_id, r.source_row, r.original_name, r.cleaned_name,
    r.is_deleted, b.is_deleted AS batch_deleted, b.created_at AS batch_created_at,
    s.file_id, s.source_file, s.source_sheet FROM rows r JOIN batches b ON b.id = r.batch_id
    JOIN sheets s ON s.id = r.sheet_id WHERE ${includeDeleted ? '1=1' : 'b.is_deleted = 0 AND r.is_deleted = 0'}
    ${batchIds ? `AND b.id IN (${batchIds.map(() => '?').join(',') || 'NULL'})` : ''} ORDER BY r.id`).all(...(batchIds || []));
  const sheets = new Map(), result = [];
  for (const row of rows) {
    if (!sheets.has(row.sheet_id)) {
      const saved = db.prepare('SELECT raw_json, header_index FROM sheets WHERE id = ?').get(row.sheet_id);
      const raw = JSON.parse(saved.raw_json), col = columns(raw[saved.header_index] || []);
      sheets.set(row.sheet_id, { raw, order: col(['체결번호']), internal: col(['내부출고번호', '내부주문번호', '출고번호', '주문번호']),
        recipient: col(['수취인명', '수취인', '송화주', '받는분']), phone: col(['수취인연락처1', '전화번호', '연락처1']),
        address: col(['통합배송지', '수취인전체주소', '주소']), quantity: col(['수량']),
        channel: col(['판매채널', '채널', '몰']), shop: col(['쇼핑몰']) });
    }
    const fields = sheets.get(row.sheet_id);
    if (rowIds && !rowIds.includes(row.id)) continue;
    const cells = fields.raw[row.source_row - 1] || [];
    const channel = compact(cells[fields.channel]), shop = compact(cells[fields.shop]);
    const supported = !channel || /^(네이버|네이버스마트스토어|스마트스토어|naver)$/i.test(channel);
    const knownOtherMall = /쿠팡|coupang|11번가|11st|G마켓|gmarket|옥션|auction|위메프|티몬|롯데온|SSG|카카오|지그재그|에이블리/i.test(shop);
    const numberProblems = [['내부 출고번호', fields.internal], ['네이버 주문번호', fields.order]].flatMap(([label, column]) => {
      if (column < 0) return [`${label} 열을 찾을 수 없습니다.`];
      const value = cells[column], field = `${label}(${XLSX.utils.encode_col(column)}열)`;
      if (idText(value)) return [];
      if (!text(value)) return [`${field}가 비어 있습니다.`];
      if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        return [`${field}가 숫자로 저장되어 원래 번호를 정확히 확인할 수 없습니다. 번호를 텍스트로 저장한 원본을 사용해 주세요.`];
      }
      return [`${field}의 형식이 올바르지 않습니다.`];
    });
    result.push({ internalId: idText(cells[fields.internal]), orderId: idText(cells[fields.order]),
      numberProblems,
      supported: supported && !knownOtherMall, deleted: Boolean(row.is_deleted || row.batch_deleted),
      recipient: text(cells[fields.recipient]), phone: text(cells[fields.phone]), address: text(cells[fields.address]), quantity: integer(cells[fields.quantity]),
      originalName: row.original_name, cleanedName: row.cleaned_name,
      source: { rowId: row.id, batchId: row.batch_id, sheetId: row.sheet_id, fileId: row.file_id,
        sourceFile: row.source_file, sourceSheet: row.source_sheet, sourceRow: row.source_row, batchCreatedAt: row.batch_created_at } });
  }
  return result;
}

function conflictingLegacy(rows, internalId) {
  return new Set(rows.filter(row => row.supported && row.internalId === internalId && row.orderId)
    .map(row => JSON.stringify([row.orderId, compact(row.recipient), phone(row.phone), compact(row.address), row.originalName]))).size > 1;
}

function signature(rows) {
  return hash(rows.map(row => JSON.stringify([row.source.rowId, row.internalId, row.orderId, row.supported,
    compact(row.recipient), phone(row.phone), compact(row.address), row.originalName])).sort());
}

function selectedBatches(db, batchIds, allowEmpty = false) {
  if (!Array.isArray(batchIds) || (!allowEmpty && !batchIds.length) || batchIds.length > 1000
    || batchIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(batchIds).size !== batchIds.length) {
    throw new Error('매칭할 저장 출고 작업을 중복 없는 작업 번호 배열로 선택해 주세요.');
  }
  const result = batchIds.map(id => db.prepare('SELECT id, name, created_at AS createdAt FROM batches WHERE id = ? AND is_deleted = 0').get(id));
  if (result.some(batch => !batch)) throw new Error('선택한 저장 출고 작업이 없거나 삭제되었습니다.');
  return result.sort((a, b) => a.id - b.id);
}

function sourceOrder(row) {
  const state = row.deleted ? 'source_deleted' : !row.supported ? 'unsupported_mall'
    : !row.internalId || !row.orderId ? 'invalid_id' : 'not_matched';
  const reasons = { source_deleted: '선택했던 저장 출고 행 또는 작업이 삭제되었습니다.', unsupported_mall: '현재 지원하지 않는 판매채널의 출고입니다.',
    invalid_id: row.numberProblems.join('\n'), not_matched: '송장 파일을 연결하기 전입니다.' };
  return { key: 'row-' + row.source.rowId, rowId: row.source.rowId, batchId: row.source.batchId,
    internalId: row.internalId, orderId: row.orderId, recipient: row.recipient, phone: row.phone, cleanedName: row.cleanedName || row.originalName, originalName: row.originalName,
    itemIds: [], trackingNumbers: [], state, reason: reasons[state], issues: [], source: { ...row.source } };
}

function outsideCandidates(scope, saved) {
  if (scope?.matchingVersion !== matchingVersion) return [];
  const targetIds = new Set(scope.orderIds || []), dates = new Set([scope.sourceDate]);
  for (const row of saved) if (targetIds.has(row.orderId)) dates.add(sourceDay(row.source.batchCreatedAt));
  return saved.filter(row => row.supported && row.orderId && !targetIds.has(row.orderId)
    && dates.has(sourceDay(row.source.batchCreatedAt)));
}

function outsideBinding(row, saved) {
  return hash([signature([row]), row.quantity, row.source.batchCreatedAt,
    signature(saved.filter(other => other.orderId === row.orderId || row.internalId && other.internalId === row.internalId))]);
}

function outsideViews(db, run, scope, saved, invalid = false) {
  const latest = run.draft_key && db.prepare('SELECT id FROM invoice_runs WHERE draft_key = ? ORDER BY id DESC LIMIT 1').get(run.draft_key);
  const staleRun = latest && latest.id !== run.id;
  return outsideCandidates(scope, saved).map(row => {
    const proof = scope.outsideOrders?.find(order => order.rowId === row.source.rowId);
    const fresh = !invalid && !staleRun && proof?.binding === outsideBinding(row, saved);
    const state = fresh ? proof.state : 'unknown';
    return { ...sourceOrder(row), sourceType: 'outside_naver', sourceDate: sourceDay(row.source.batchCreatedAt),
      state, reason: fresh ? proof.reason : proof ? '주문 근거가 바뀌었습니다. 등록 상태를 다시 확인해 주세요.' : '네이버 등록 여부를 아직 확인하지 않았습니다.',
      trackingNumbers: fresh ? proof.trackingNumbers || [] : [], productOrderIds: fresh ? proof.productOrderIds || [] : [],
      checkedAt: fresh ? proof.checkedAt : null, evidence: fresh ? proof.evidence || [] : [],
      externalRegistration: state === 'external_registered' };
  });
}

export function invoiceOrderSources(db, batchIds) {
  const batches = selectedBatches(db, batchIds, true), saved = legacyRows(db, { batchIds: batches.map(batch => batch.id) });
  if (!saved.length) return { batches, orders: [] };
  const runs = db.prepare(`SELECT id FROM invoice_runs WHERE scope_json IS NOT NULL
    AND (EXISTS (SELECT 1 FROM json_each(scope_json, '$.batchIds') selected WHERE selected.value IN (${batches.map(() => '?').join(',')}))
      OR EXISTS (SELECT 1 FROM json_each(scope_json, '$.outsideBatchIds') selected WHERE selected.value IN (${batches.map(() => '?').join(',')})))
    ORDER BY id DESC`).all(...batches.map(batch => batch.id), ...batches.map(batch => batch.id));
  const details = runs.map(run => invoiceDetail(db, run.id));
  const orders = saved.map(row => {
    for (const detail of details) {
      const order = detail.orders.find(order => order.rowId === row.source.rowId && order.itemIds.length
        && order.itemIds.some(id => !detail.items.find(item => item.id === id)?.superseded));
      if (order) return { ...order, latestRunId: detail.run.id, processingDate: detail.run.sourceDate };
      const outside = detail.outsideOrders.find(order => order.rowId === row.source.rowId);
      if (outside) return { ...outside, latestRunId: detail.run.id, processingDate: detail.run.sourceDate };
    }
    const order = sourceOrder(row);
    if (order.state === 'not_matched' && details.some(detail => detail.run.matchingVersion === matchingVersion && detail.batchIds.includes(row.source.batchId))) {
      order.state = 'not_targeted'; order.reason = '최근 네이버 파일의 처리 대상이 아닙니다. 등록 여부는 확인하지 않았습니다.';
    }
    return order;
  });
  return { batches, orders };
}

function printComparison(a, b) {
  const clock = value => /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)
    ? value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) : null;
  const left = clock(a.printedAt), right = clock(b.printedAt);
  if (left !== null || right !== null) return left !== null && right !== null && a.printFileHash
    && a.printFileHash === b.printFileHash ? left - right : NaN;
  return Date.parse(a.printedAt) - Date.parse(b.printedAt);
}

function physicalParcels(records, issues, internalId, previous = []) {
  const byNumber = new Map();
  for (const record of records) {
    if (!byNumber.has(record.trackingNumber)) byNumber.set(record.trackingNumber, []);
    byNumber.get(record.trackingNumber).push(record);
  }
  const shipments = [...byNumber].map(([trackingNumber, prints]) => {
    const latest = [...prints].sort((a, b) => printComparison({ ...b, printFileHash: b.source.fileHash },
      { ...a, printFileHash: a.source.fileHash }) || (b.issueCount || 0) - (a.issueCount || 0))[0];
    const originals = new Set(prints.map(row => row.originalTrackingNumber).filter(Boolean));
    if (originals.size > 1) issue(issues, 'reprint_conflict', '원송장 관계가 서로 달라 재발급 여부를 확인해야 합니다.', { internalId, blocking: true });
    return { internalId, trackingNumber, round: latest.round, originalTrackingNumber: latest.originalTrackingNumber,
      issueCount: latest.issueCount, printedAt: latest.printedAt, printFileHash: latest.source.fileHash, valid: true, replacedBy: null,
      sources: prints.map(row => row.source) };
  });
  for (const old of previous) {
    const current = shipments.find(row => row.trackingNumber === old.trackingNumber);
    if (!current) shipments.push({ ...old, valid: true, replacedBy: null });
    else current.sources = [...new Map([...old.sources, ...current.sources].map(source => [JSON.stringify(source), source])).values()];
  }
  for (const shipment of shipments) {
    if (!shipment.originalTrackingNumber || shipment.originalTrackingNumber === shipment.trackingNumber) continue;
    const previous = shipments.find(row => row.trackingNumber === shipment.originalTrackingNumber);
    if (!previous || (previous.replacedBy && previous.replacedBy !== shipment.trackingNumber)
      || !Number.isFinite(printComparison(shipment, previous)) || printComparison(shipment, previous) <= 0) {
      issue(issues, 'reprint_uncertain', '원송장과 새 송장의 연결·출력 순서가 불명확합니다.', { internalId, blocking: true });
      shipment.valid = null;
    } else { previous.valid = false; previous.replacedBy = shipment.trackingNumber; }
  }
  const byRound = new Map();
  for (const shipment of shipments.filter(row => row.valid === true)) {
    const round = integer(shipment.round);
    if (round === null) continue;
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round).push(shipment);
  }
  for (const sameRound of byRound.values()) {
    if (sameRound.length < 2) continue;
    const sorted = [...sameRound].sort((a, b) => printComparison(a, b));
    if (sorted.every((row, index) => row.issueCount !== null && (!index
      || (Number.isFinite(printComparison(row, sorted[index - 1])) && printComparison(row, sorted[index - 1]) > 0
        && row.issueCount > sorted[index - 1].issueCount)))) {
      for (let index = 0; index < sorted.length - 1; index++) {
        sorted[index].valid = false; sorted[index].replacedBy = sorted[index + 1].trackingNumber;
        sorted[index].replacementBasis = 'later_print_and_issue_count';
      }
    }
  }
  const active = shipments.filter(row => row.valid !== false);
  let representative = active[0]?.trackingNumber || '';
  if (active.length > 1) {
    const rounds = active.map(row => integer(row.round));
    if (rounds.every(value => value !== null) && new Set(rounds).size === active.length
      && !issues.some(row => row.internalId === internalId && row.blocking)) {
      representative = [...active].sort((a, b) => integer(a.round) - integer(b.round))[0].trackingNumber;
    } else {
      for (const row of active) row.valid = null;
      representative = '';
      issue(issues, 'parcel_uncertain', '여러 송장의 분할 상자·재발급 구분 근거가 부족합니다.', { internalId, blocking: true });
    }
  }
  const currentRecords = [...byNumber].filter(([number]) => shipments.some(row => row.trackingNumber === number && row.valid === true))
    .map(([number, prints]) => prints.find(row => row.printedAt === shipments.find(shipment => shipment.trackingNumber === number).printedAt) || prints[0]);
  if (currentRecords.length > 1 && new Set(currentRecords.map(row => JSON.stringify([compact(row.recipient), phone(row.phone), compact(row.address)]))).size > 1) {
    issue(issues, 'courier_conflict', '같은 내부 출고번호의 택배 수취 정보가 서로 다릅니다.', { internalId, blocking: true });
  }
  return { shipments, representative };
}

function runRecord(db, id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error('송장 작업 번호를 확인해 주세요.');
  const run = db.prepare('SELECT * FROM invoice_runs WHERE id = ?').get(Number(id));
  if (!run) throw new Error('송장 작업을 찾을 수 없습니다.');
  return run;
}

export function importInvoiceFiles(db, { naverFiles, courierFiles, mall = 'naver', store = 'default', carrier, batchIds, sourceDate, runningBatchIds = [] } = {}) {
  if (mall !== 'naver' || typeof store !== 'string' || !store.trim() || store.length > 120) throw new Error('현재 지원하는 몰과 스토어를 확인해 주세요.');
  if (!CARRIERS.some(item => item.code === carrier?.code && item.name === carrier?.name)) throw new Error('택배사를 목록에서 명시적으로 선택해 주세요.');
  if (sourceDate === undefined && batchIds === undefined) throw new Error('송장 처리 날짜 또는 조회할 주문 작업을 확인해 주세요.');
  const requested = batchIds === undefined ? [] : selectedBatches(db, batchIds, sourceDate !== undefined);
  const processingDate = sourceDate === undefined ? requested.map(batch => sourceDay(batch.createdAt)).sort().at(-1) || sourceDay(Date.now()) : sourceDate;
  invoiceDateRange(processingDate);
  if (processingDate === undefined) throw new Error('송장 처리 기준 날짜를 확인해 주세요.');
  const files = [...inputFiles(naverFiles, 'naver'), ...inputFiles(courierFiles, 'courier')];
  const issues = [], { products, parcels } = parseInputs(files, issues), orderIds = new Set(products.map(product => product.orderId));
  const allSaved = legacyRows(db), saved = allSaved.filter(row => orderIds.has(row.orderId));
  const scopeIds = [...new Set(saved.map(row => row.source.batchId))].sort((a, b) => a - b);
  const outsideBatchIds = [...new Set(outsideCandidates({ matchingVersion, sourceDate: processingDate, orderIds: [...orderIds] }, allSaved)
    .map(row => row.source.batchId))];
  const evidenceInternalIds = [...new Set(saved.map(row => row.internalId).filter(Boolean))];
  const evidence = allSaved.filter(row => orderIds.has(row.orderId) || evidenceInternalIds.includes(row.internalId));
  if (scopeIds.some(id => runningBatchIds.includes(id))) throw new Error('연결할 주문의 상품명 정리가 진행 중입니다. 완료 후 매칭해 주세요.');
  const draftKey = hash([matchingVersion, mall, store.trim(), carrier.code, processingDate]);
  const relevant = saved.filter(row => row.supported && row.internalId && row.orderId);
  const inputFingerprint = hash([matchingVersion, mall, store.trim(), carrier.code, processingDate, scopeIds,
    files.map(file => [file.kind, file.sha256]).sort(), signature(evidence)]);
  const existing = db.prepare(`SELECT id, generated_at FROM invoice_runs WHERE fingerprint = ?
    OR json_extract(scope_json, '$.inputFingerprint') = ? ORDER BY id DESC LIMIT 1`).get(inputFingerprint, inputFingerprint);
  const latestDraft = db.prepare('SELECT id FROM invoice_runs WHERE draft_key = ? ORDER BY id DESC LIMIT 1').get(draftKey);
  if (existing && (existing.generated_at || existing.id === latestDraft?.id)) return invoiceDetail(db, existing.id);
  const fingerprint = existing ? hash([inputFingerprint, randomUUID()]) : inputFingerprint;
  const internal = new Map();
  for (const parcel of parcels.filter(row => row.validIds)) {
    if (!internal.has(parcel.internalId)) internal.set(parcel.internalId, []);
    internal.get(parcel.internalId).push(parcel);
  }
  const previous = db.prepare(`SELECT i.*, r.carrier_code FROM invoice_items i JOIN invoice_runs r ON r.id = i.run_id
    WHERE r.mall = ? AND r.store = ? AND r.carrier_code = ? ORDER BY i.id DESC`).all(mall, store.trim(), carrier.code);
  const physical = new Map([...internal].map(([key, records]) => {
    const orderIds = new Set(relevant.filter(row => row.internalId === key).map(row => row.orderId));
    const old = previous.find(row => orderIds.has(row.order_id) && (row.internal_id === key
      || JSON.parse(row.shipments_json).some(parcel => parcel.internalId === key)));
    const history = old ? JSON.parse(old.shipments_json).filter(parcel => parcel.internalId === key || (!parcel.internalId && old.internal_id === key)) : [];
    return [key, physicalParcels(records, issues, key, history)];
  }));
  for (const row of saved) {
    const extra = { internalId: row.internalId, source: row.source };
    if (!row.supported) issue(issues, 'unsupported_mall', '선택한 출고 중 현재 지원하지 않는 판매채널이 있습니다.', extra);
    else if (!row.internalId || !row.orderId) issue(issues, 'invalid_saved_id', row.numberProblems.join('\n'), extra);
    else if (!products.some(product => product.orderId === row.orderId)) issue(issues, 'missing_naver_order', '저장된 출고는 있으나 연결할 네이버 주문 원본이 없습니다.', extra);
    else if (!physical.has(row.internalId)) issue(issues, 'missing_courier', '선택한 저장 출고에 연결되는 유효한 택배 송장이 없습니다.', extra);
  }
  for (const [internalId] of internal) {
    const matches = relevant.filter(row => row.internalId === internalId);
    if (!matches.length) issue(issues, 'unmatched_courier', '저장된 유효 주문에 연결되지 않는 택배 송장이 있습니다. 취소로 단정하지 않고 확인해 주세요.', { internalId });
    else if (!matches.some(row => products.some(product => product.orderId === row.orderId))) {
      issue(issues, 'missing_naver_order', '저장된 출고는 있으나 연결할 네이버 주문 원본이 없습니다.', { internalId });
    }
    else if (conflictingLegacy(allSaved, internalId)) {
      issue(issues, 'legacy_conflict', '같은 내부 출고번호의 저장 주문 내용이 서로 다릅니다.', { internalId, blocking: true });
    }
  }
  const prepared = products.map(product => {
    const matches = relevant.filter(row => row.orderId === product.orderId), ids = [...new Set(matches.map(row => row.internalId).filter(Boolean))];
    let internalId = ids.length === 1 ? ids[0] : '';
    let parcel = physical.get(internalId) || { shipments: ids.flatMap(key => physical.get(key)?.shipments || []), representative: '' };
    const sameRecipient = matches.every(row => compact(row.recipient) === compact(product.recipient)
      && phone(row.phone) === phone(product.phone) && compact(row.address) === compact(product.address));
    const active = parcel.shipments.filter(shipment => shipment.valid === true);
    if (ids.length > 1 && products.filter(row => row.orderId === product.orderId).length === 1 && sameRecipient
      && matches.every(row => row.internalId && physical.has(row.internalId))
      && ids.every(key => physical.has(key) && !issues.some(warning => warning.internalId === key && warning.blocking))
      && !parcel.shipments.some(shipment => shipment.valid === null) && active.length
      && active.every(shipment => integer(shipment.round) !== null)
      && new Set(active.map(shipment => integer(shipment.round))).size === active.length
      && new Set(active.map(shipment => shipment.trackingNumber)).size === active.length) {
      const first = [...active].sort((a, b) => integer(a.round) - integer(b.round))[0];
      internalId = first.internalId;
      parcel = { ...parcel, representative: first.trackingNumber };
    }
    if (!matches.length) issue(issues, 'missing_saved_order', '① 네이버 발송 대상이지만 ② 확인한 주문에 연결할 유효한 주문번호가 없고 ③ 송장도 연결되지 않았습니다. 누락 여부를 확인해 주세요.',
      { productOrderId: product.productOrderId, blocking: true });
    else if (!internalId || !physical.has(internalId)) issue(issues, ids.length > 1 ? 'split_mapping' : 'unmatched_order',
      ids.length > 1 ? '같은 주문의 여러 내부 출고와 개별 상품의 연결을 확인해야 합니다.' : '상품주문에 연결되는 내부 출고 또는 송장이 없습니다.',
      { productOrderId: product.productOrderId, blocking: true });
    if (matches.length && !sameRecipient) {
      issue(issues, 'recipient_mismatch', '네이버 원본과 저장된 주문의 수취 정보가 다릅니다.', { productOrderId: product.productOrderId });
    }
    if (canceled(product.status) || /취소|반품/.test(product.detailStatus)) {
      issue(issues, 'source_canceled', '네이버 원본에 취소·반품 정보가 있어 출고 대상에서 보류했습니다.', { productOrderId: product.productOrderId, blocking: true });
    }
    if (product.sourceTrackingNumber && product.sourceTrackingNumber !== parcel.representative) issue(issues, 'source_tracking_conflict',
      '네이버 원본에 이미 다른 송장이 등록되어 있습니다.', { productOrderId: product.productOrderId, blocking: true });
    const sourceComplete = product.sourceTrackingNumber === parcel.representative && parcel.representative
      && [carrier.code, carrier.name].includes(product.sourceCarrier) && registeredStatuses.has(compact(product.status));
    return { product, internalId, matches, ...parcel, sourceComplete: Boolean(sourceComplete) };
  });
  const trackingOrders = new Map();
  for (const item of prepared) for (const shipment of item.shipments.filter(row => row.valid !== false)) {
    if (!trackingOrders.has(shipment.trackingNumber)) trackingOrders.set(shipment.trackingNumber, new Set());
    trackingOrders.get(shipment.trackingNumber).add(item.product.orderId);
  }
  for (const item of prepared) if (item.shipments.some(row => trackingOrders.get(row.trackingNumber)?.size > 1)) {
    issue(issues, 'center_required', '서로 다른 네이버 주문번호의 합포장은 네이버 센터에서 처리해야 합니다.', { productOrderId: item.product.productOrderId, blocking: true });
  }
  const registrationSignature = (product, internalId, trackingNumber, shipments) => hash([
    product.orderId, product.quantity, compact(product.recipient), phone(product.phone), compact(product.address), internalId, trackingNumber,
    shipments.map(parcel => [parcel.internalId, parcel.trackingNumber, parcel.round, parcel.originalTrackingNumber, parcel.valid, parcel.replacedBy]).sort(),
  ]);
  const previousDetails = new Map();
  for (const item of prepared) {
    const prior = previous.find(row => row.product_order_id === item.product.productOrderId);
    if (!prior) continue;
    const expected = JSON.parse(prior.expected_json), oldShipments = JSON.parse(prior.shipments_json);
    const sameBasis = registrationSignature(expected, prior.internal_id, prior.tracking_number, oldShipments)
      === registrationSignature(item.product, item.internalId, prior.tracking_number, item.shipments)
      && item.shipments.some(parcel => parcel.valid === true && parcel.trackingNumber === prior.tracking_number);
    const sameReview = sameBasis && ['status', 'detailStatus', 'sourceTrackingNumber', 'sourceCarrier']
      .every(key => expected[key] === item.product[key]);
    if (sameReview && (prior.note || db.prepare('SELECT 1 FROM invoice_revisions WHERE item_id = ? LIMIT 1').get(prior.id))) {
      item.reviewPrior = prior;
      item.representative = prior.tracking_number;
    }
    if (!previousDetails.has(prior.run_id)) previousDetails.set(prior.run_id, invoiceDetail(db, prior.run_id));
    const oldDetail = previousDetails.get(prior.run_id), old = oldDetail.items.find(row => row.id === prior.id);
    if (sameReview) for (const warning of issues) {
      const reviewed = oldDetail.issues.find(saved => saved.key === warning.key && saved.message === warning.message && saved.resolved);
      if (reviewed) { warning.resolved = true; warning.note = reviewed.note; }
    }
    if (!item.sourceComplete && ((prior.status_checked_at && prior.registration_state === 'complete')
      || (expected.registrationRecheck && (!old?.statusFresh || !['pending', 'complete'].includes(prior.registration_state))))) item.registrationRecheck = true;
    if (!prior.status_checked_at || !['complete', 'conflict'].includes(prior.registration_state)) continue;
    if (!old?.statusFresh || old.superseded) continue;
    if (prior.registration_state === 'complete' && !item.sourceComplete) continue;
    if (registrationSignature(expected, prior.internal_id, prior.tracking_number, oldShipments)
      === registrationSignature(item.product, item.internalId, item.representative, item.shipments)) item.prior = prior;
  }
  const id = transaction(db, () => {
    const runId = Number(db.prepare(`INSERT INTO invoice_runs (mall, store, carrier_name, carrier_code, fingerprint, legacy_signature, issues_json, scope_json, draft_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(mall, store.trim(), carrier.name, carrier.code, fingerprint, signature(evidence), JSON.stringify(issues),
      JSON.stringify({ sourceDate: processingDate, orderIds: [...orderIds], evidenceInternalIds, batchIds: scopeIds, outsideBatchIds,
        sourceRowIds: saved.map(row => row.source.rowId), inputFingerprint, matchingVersion }), draftKey).lastInsertRowid);
    const addFile = db.prepare('INSERT INTO invoice_files (run_id, kind, name, sha256, content) VALUES (?, ?, ?, ?, ?)');
    for (const file of files) addFile.run(runId, file.kind, file.name, file.sha256, file.buffer);
    const addItem = db.prepare(`INSERT INTO invoice_items (run_id, product_order_id, order_id, internal_id, tracking_number,
      expected_json, shipments_json, source_rows_json, decision, note, registration_state, status_checked_at, status_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of prepared) {
      const warnings = issues.filter(warning => warning.productOrderId === item.product.productOrderId
        || warning.internalId && item.shipments.some(shipment => shipment.internalId === warning.internalId));
      const originalDecision = item.registrationRecheck || warnings.some(warning => warning.blocking || !warning.resolved) || !item.representative ? 'hold' : 'include';
      const review = item.reviewPrior, safeReview = review && (review.decision !== 'include' || (!item.registrationRecheck && !warnings.some(warning => warning.blocking || !warning.resolved)));
      const decision = safeReview ? review.decision : originalDecision, note = safeReview || item.registrationRecheck ? review?.note || '' : '';
      const inserted = addItem.run(runId, item.product.productOrderId, item.product.orderId, item.internalId, item.representative,
        JSON.stringify({ ...item.product, registrationRecheck: Boolean(item.registrationRecheck), sourceComplete: item.sourceComplete, cleanedName: item.matches[0]?.cleanedName || item.product.productName }),
        JSON.stringify(item.shipments), JSON.stringify(item.matches.map(row => row.source)),
        decision, note, item.prior?.registration_state || 'unchecked',
        item.prior?.status_checked_at || null, item.prior?.status_json || null);
      if (safeReview || (item.registrationRecheck && review)) db.prepare('INSERT INTO invoice_revisions (item_id, before_json, after_json) VALUES (?, ?, ?)').run(Number(inserted.lastInsertRowid),
        JSON.stringify({ decision: originalDecision, note: '', trackingNumber: item.representative }),
        JSON.stringify({ decision, note, trackingNumber: item.representative, copiedFromItemId: review.id }));
    }
    if (prepared.length && prepared.every(item => item.prior?.status_checked_at)) db.prepare('UPDATE invoice_runs SET status_checked_at = ? WHERE id = ?')
      .run(prepared.map(item => item.prior.status_checked_at).sort()[0], runId);
    return runId;
  });
  return invoiceDetail(db, id);
}

function currentItems(db, run) {
  return db.prepare(`SELECT i.* FROM invoice_items i JOIN invoice_runs r ON r.id = i.run_id
    WHERE r.mall = ? AND r.store = ? ORDER BY i.id DESC`).all(run.mall, run.store);
}

function orderViews(saved, parcels, items, issues, allSaved) {
  const orders = saved.map(row => {
    const result = sourceOrder(row), related = items.filter(item => item.sourceRows.some(source => source.rowId === row.source.rowId));
    const couriers = row.internalId ? parcels.filter(parcel => parcel.internalId === row.internalId) : [];
    result.itemIds = related.map(item => item.id);
    result.trackingNumbers = [...new Set(couriers.map(parcel => parcel.trackingNumber || parcel.originalTrackingNumberValue).filter(Boolean))];
    result.courierRows = couriers.map(parcel => ({ trackingNumber: parcel.trackingNumber || parcel.originalTrackingNumberValue, ...parcel.source }));
    const warnings = issues.filter(warning => warning.source?.rowId === row.source.rowId
      || (row.internalId && warning.internalId === row.internalId) || related.some(item => item.issues.includes(warning.key)));
    result.issues = warnings.map(warning => warning.key);
    if (result.state !== 'not_matched') return result;
    if (couriers.some(parcel => !parcel.validIds)) {
      result.state = 'invalid_id'; result.reason = [...new Set(couriers.filter(parcel => !parcel.validIds).map(courierIdReason))].join('\n');
    }
    else if (!related.length) { result.state = 'missing_naver'; result.reason = '이 출고의 주문번호와 연결되는 네이버 상품주문이 없습니다.'; }
    else if (!couriers.length) { result.state = 'missing_courier'; result.reason = '이 출고번호와 연결되는 택배사 송장이 없습니다.'; }
    else if (related.every(item => item.decision === 'exclude')) { result.state = 'excluded'; result.reason = '담당자가 등록 대상에서 제외했습니다.'; }
    else if (related.some(item => item.decision !== 'include' || item.registrationState === 'conflict' || item.superseded)
      || warnings.some(warning => warning.blocking || !warning.resolved)) {
      result.state = 'hold'; result.reason = warnings.find(warning => warning.blocking || !warning.resolved)?.message
        || related.find(item => item.registrationState === 'conflict')?.registrationNote || '연결된 상품주문을 보류하거나 확인할 내용이 있습니다.';
    } else if (related.every(item => item.registrationState === 'complete' && item.statusFresh)) {
      result.state = 'complete'; result.reason = '연결된 모든 상품주문의 송장 등록을 조회로 확인했습니다.';
    } else { result.state = 'ready'; result.reason = '선택한 출고와 송장이 연결되었습니다.'; }
    return result;
  });
  for (const item of items.filter(item => !item.sourceRows.length)) orders.push({
    key: 'naver-' + item.productOrderId, sourceType: 'naver_only', rowId: null, batchId: null,
    productOrderId: item.productOrderId, orderId: item.orderId, internalId: item.internalId,
    recipient: item.recipient, phone: item.phone, cleanedName: item.productName, originalName: item.productName,
    optionName: item.optionName, itemIds: [item.id], trackingNumbers: [], courierRows: [],
    state: 'missing_saved_order', reason: '① 네이버에는 있으나 ② 확인한 주문과 ③ 송장에 연결되지 않은 발송 대상입니다.',
    issues: item.issues, source: { ...item.naverSources?.[0] },
  });
  const unmatchedCouriers = parcels.filter(parcel => !parcel.internalId || !saved.some(row => row.internalId === parcel.internalId)).map(parcel => {
    const outside = parcel.internalId && allSaved.some(row => row.internalId === parcel.internalId);
    const state = !parcel.validIds ? 'invalid_id' : outside ? 'outside_scope' : 'missing_saved_order';
    const reason = state === 'invalid_id' ? courierIdReason(parcel)
      : state === 'outside_scope' ? '같은 내부 출고번호의 저장 주문은 있으나 이번에 선택한 작업 범위 밖입니다.'
        : '같은 내부 출고번호의 유효한 저장 출고 주문을 찾을 수 없습니다.';
    const warning = issues.find(warning => warning.source?.fileHash === parcel.source.fileHash
      && warning.source?.sourceSheet === parcel.source.sourceSheet && warning.source?.sourceRow === parcel.source.sourceRow)
      || issues.find(warning => warning.internalId === parcel.internalId && warning.kind === 'unmatched_courier');
    return { key: hash(parcel.source).slice(0, 24), recipient: parcel.recipient, phone: parcel.phone,
      trackingNumber: parcel.trackingNumber || parcel.originalTrackingNumberValue, internalId: parcel.internalId || parcel.originalInternalId,
      ...parcel.source, source: { ...parcel.source }, issueKey: warning?.key || '', state, reason };
  });
  return { orders, unmatchedCouriers };
}

export function invoiceDetail(db, id) {
  const run = runRecord(db, id), issues = JSON.parse(run.issues_json).filter(warning => warning.kind !== 'registration_recheck'), scope = run.scope_json ? JSON.parse(run.scope_json) : null;
  const batchIds = scope?.batchIds || [], scopeRequired = !scope;
  const rematchRequired = Boolean(scope && scope.matchingVersion !== matchingVersion);
  const allSaved = scope ? legacyRows(db) : [];
  const saved = scope ? scope.matchingVersion === matchingVersion
    ? allSaved.filter(row => (scope.orderIds || []).includes(row.orderId)) : legacyRows(db, { batchIds }) : [];
  const evidence = scope?.matchingVersion === matchingVersion ? allSaved.filter(row => (scope.orderIds || []).includes(row.orderId)
    || (scope.evidenceInternalIds || []).includes(row.internalId)) : saved;
  const selected = scope ? legacyRows(db, { batchIds, rowIds: scope.sourceRowIds, includeDeleted: true }) : [];
  for (const warning of issues.filter(warning => warning.kind === 'invalid_saved_id')) {
    const row = selected.find(row => row.source.rowId === warning.source?.rowId);
    if (row?.numberProblems.length) warning.message = row.numberProblems.join('\n');
  }
  const records = db.prepare('SELECT * FROM invoice_items WHERE run_id = ? ORDER BY id').all(run.id);
  const current = currentItems(db, run);
  if (scopeRequired) issue(issues, 'scope_required', '저장 출고 작업 범위가 지정되지 않은 과거 내역입니다. 작업을 선택해 새로 매칭해 주세요.', { blocking: true });
  else if (signature(evidence) !== run.legacy_signature) issue(issues, 'source_changed', '연결 근거인 저장 주문이 바뀌었습니다. 현재 유효 주문으로 매칭을 다시 확인해 주세요.', { blocking: true });
  const items = records.map(record => {
    const expected = JSON.parse(record.expected_json), sourceRows = JSON.parse(record.source_rows_json);
    const lastStatus = record.status_json ? JSON.parse(record.status_json) : {};
    const problems = lastStatus.problems || [];
    const problemLabels = { order_changed: '주문번호 변경', recipient_changed: '수취 정보 변경', quantity_changed: '잔여 수량 변경',
      claim: '취소·클레임 확인 필요', wrong_tracking: '잘못된 송장', tracking_conflict: '다른 송장·택배사 등록', registration_incomplete: '등록 정보 누락', status: '출고할 수 없는 주문 상태' };
    const superseded = current.find(row => row.product_order_id === record.product_order_id)?.id !== record.id;
    if (superseded) issue(issues, 'superseded', '같은 상품주문의 더 새로운 송장 작업이 있습니다. 최신 작업을 사용해 주세요.', { productOrderId: record.product_order_id, blocking: true });
    const statusFresh = Boolean(record.status_checked_at) && !superseded && !scopeRequired && !issues.some(warning => warning.kind === 'source_changed');
    return { id: record.id, productOrderId: record.product_order_id, orderId: record.order_id, internalId: record.internal_id,
      trackingNumber: record.tracking_number, physicalShipments: JSON.parse(record.shipments_json), sourceRows,
      naverSources: expected.sources, batchIds: [...new Set(sourceRows.map(row => row.batchId))],
      recipient: expected.recipient, phone: expected.phone, quantity: expected.quantity, cleanedName: expected.cleanedName,
      productName: expected.productName, optionName: expected.optionName || '',
      registrationRecheck: Boolean(expected.registrationRecheck), decision: record.decision, note: record.note, superseded, statusFresh, checkedAt: record.status_checked_at,
      registrationState: superseded || (record.status_checked_at && !statusFresh) ? 'unchecked' : record.registration_state,
      registrationProblems: problems, registrationNote: statusFresh
        ? lastStatus.note || problems.map(problem => problemLabels[problem] || '등록 정보 확인 필요').join(', ') : '',
      sourceDate: sourceRows.length ? sourceDay(sourceRows.map(row => row.batchCreatedAt).filter(Boolean).sort()[0]) : '',
      sourceRegistered: expected.sourceComplete && expected.sourceTrackingNumber === record.tracking_number, issues: [] };
  });
  if (scope?.matchingVersion === matchingVersion) {
    const internalIds = new Set(items.flatMap(item => [item.internalId, ...item.physicalShipments.map(parcel => parcel.internalId)]).filter(Boolean));
    for (const internalId of internalIds) if (conflictingLegacy(allSaved, internalId)) {
      issue(issues, 'legacy_conflict', '같은 내부 출고번호의 저장 주문 내용이 서로 다릅니다.', { internalId, blocking: true });
    }
  }
  for (const item of items) if (item.registrationRecheck && (!item.statusFresh || !['pending', 'complete'].includes(item.registrationState))) {
    issue(issues, 'registration_recheck', '이전 등록 확인과 최신 네이버 파일이 다릅니다. 등록 상태를 다시 조회해 주세요.', { productOrderId: item.productOrderId, blocking: true });
  }
  for (const item of items) item.issues = issues.filter(warning => warning.blocking && !warning.productOrderId && !warning.internalId && !warning.source
    || warning.productOrderId === item.productOrderId || (item.internalId && warning.internalId === item.internalId)
    || (warning.internalId && item.physicalShipments.some(parcel => parcel.internalId === warning.internalId))
    || (warning.source?.rowId && item.sourceRows.some(source => source.rowId === warning.source.rowId))).map(warning => warning.key);
  const processingDate = scope?.sourceDate || sourceDay(run.created_at);
  const summary = { selectedDate: items.filter(item => item.sourceDate === processingDate).length,
    otherDate: items.filter(item => item.sourceDate && item.sourceDate !== processingDate).length, unknownDate: items.filter(item => !item.sourceDate).length,
    total: items.length, connected: items.filter(item => item.sourceRows.length).length,
    missingSaved: items.filter(item => !item.sourceRows.length).length, included: 0, held: 0, excluded: 0, complete: 0, issues: 0 };
  for (const item of items) { summary[{ include: 'included', hold: 'held', exclude: 'excluded' }[item.decision]]++; if (item.registrationState === 'complete') summary.complete++; }
  const files = db.prepare('SELECT id, kind, name, sha256 FROM invoice_files WHERE run_id = ? ORDER BY id').all(run.id);
  const courierFiles = db.prepare("SELECT name, sha256, content FROM invoice_files WHERE run_id = ? AND kind = 'courier' ORDER BY id")
    .all(run.id).map(file => ({ ...file, kind: 'courier', buffer: Buffer.from(file.content) }));
  const parcels = courierFiles.length ? parseInputs(courierFiles, []).parcels : [];
  const views = scope ? orderViews(selected, parcels, items, issues, allSaved) : { orders: [], unmatchedCouriers: [] };
  const selectedIssueKeys = new Set([...items, ...views.orders].flatMap(row => row.issues));
  for (const warning of issues) {
    const courierOnly = !warning.productOrderId && warning.kind !== 'invalid_naver_id' && views.unmatchedCouriers.some(row => row.issueKey === warning.key
      || (warning.internalId && warning.internalId === row.internalId)
      || (warning.source?.fileHash && warning.source.fileHash === row.source.fileHash
        && warning.source.sourceSheet === row.source.sourceSheet && warning.source.sourceRow === row.source.sourceRow));
    warning.reviewRequired = selectedIssueKeys.has(warning.key) || !courierOnly;
  }
  summary.issues = issues.filter(warning => warning.reviewRequired && !warning.resolved).length;
  const outsideOrders = outsideViews(db, run, scope, allSaved, scopeRequired || rematchRequired || issues.some(warning => warning.kind === 'source_changed'));
  const outsideSummary = { total: outsideOrders.length, registered: 0, pending: 0, canceled: 0, returned: 0, attention: 0, unknown: 0 };
  for (const order of outsideOrders) outsideSummary[order.state === 'external_registered' ? 'registered' : order.state]++;
  const batches = batchIds.map(batchId => db.prepare('SELECT id, name, created_at AS createdAt FROM batches WHERE id = ?').get(batchId)).filter(Boolean);
  return { run: { id: run.id, mall: run.mall, store: run.store, carrierName: run.carrier_name, carrierCode: run.carrier_code,
    createdAt: run.created_at, statusCheckedAt: run.status_checked_at, generatedAt: run.generated_at,
    savedFileAvailable: Boolean(run.generated_file?.length), draftKey: run.draft_key, isDraft: !run.generated_at, batchIds,
    sourceDate: processingDate, matchingVersion: scope?.matchingVersion || '', outsideCheckedAt: scope?.outsideCheckedAt || null }, items, issues, summary, files, outsideOrders, outsideSummary,
    batchIds, batches, scopeRequired, rematchRequired, ...views };
}

function invoiceDateRange(date) {
  if (date === undefined) return [];
  const value = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0000') ? Date.parse(date + 'T00:00:00Z') : NaN;
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new Error('송장 조회 날짜를 YYYY-MM-DD 형식으로 확인해 주세요.');
  return [new Date(value - 9 * 3600000).toISOString(), new Date(value + 15 * 3600000).toISOString()];
}

function invoiceRunMetadata(db, records) {
  return records.map(run => {
    const detail = invoiceDetail(db, run.id), total = detail.items.length;
    const eligible = item => item.statusFresh && item.decision === 'include'
      && !detail.issues.some(warning => item.issues.includes(warning.key) && (warning.blocking || !warning.resolved));
    const complete = detail.items.filter(item => eligible(item) && item.registrationState === 'complete').length;
    const conflict = detail.items.filter(item => item.statusFresh && item.registrationState === 'conflict').length;
    const registrationState = conflict ? 'conflict' : total && complete === total ? 'complete' : complete ? 'partial'
      : detail.items.some(item => item.statusFresh) ? 'pending' : 'unchecked';
    return { ...detail.run, files: detail.files.map(({ kind, name }) => ({ kind, name })),
      registrationState, registrationSummary: { total, complete, conflict } };
  });
}

function runDateClause(column) {
  return `(CASE WHEN json_extract(scope_json, '$.sourceDate') IS NOT NULL THEN json_extract(scope_json, '$.sourceDate')
    ELSE date(${column}, '+9 hours') END) = ?`;
}

export function listInvoiceRuns(db, date) {
  invoiceDateRange(date);
  return invoiceRunMetadata(db, db.prepare(`SELECT id FROM invoice_runs WHERE generated_at IS NOT NULL
    ${date === undefined ? '' : 'AND ' + runDateClause('generated_at')}
    ORDER BY generated_at DESC, id DESC${date === undefined ? ' LIMIT 50' : ''}`).all(...(date === undefined ? [] : [date])));
}

export function listInvoiceDrafts(db, date) {
  invoiceDateRange(date);
  return invoiceRunMetadata(db, db.prepare(`SELECT r.id FROM invoice_runs r WHERE r.generated_at IS NULL
    AND r.scope_json IS NOT NULL AND r.draft_key <> ''
    AND r.id = (SELECT MAX(latest.id) FROM invoice_runs latest WHERE latest.draft_key = r.draft_key)
    ${date === undefined ? '' : `AND (json_extract(r.scope_json, '$.sourceDate') = ? OR (json_extract(r.scope_json, '$.sourceDate') IS NULL
      AND EXISTS (SELECT 1 FROM json_each(r.scope_json, '$.batchIds') selected JOIN batches b ON b.id = selected.value WHERE date(b.created_at, '+9 hours') = ?)))`}
    ORDER BY r.id DESC${date === undefined ? ' LIMIT 50' : ''}`).all(...(date === undefined ? [] : [date, date])));
}

export function latestInvoice(db, date) {
  if (date === undefined) throw new Error('이어갈 주문 작업 날짜를 YYYY-MM-DD 형식으로 선택해 주세요.');
  invoiceDateRange(date);
  const run = db.prepare(`SELECT r.id FROM invoice_runs r WHERE r.scope_json IS NOT NULL
    AND (json_extract(r.scope_json, '$.sourceDate') = ? OR (json_extract(r.scope_json, '$.sourceDate') IS NULL
      AND EXISTS (SELECT 1 FROM json_each(r.scope_json, '$.batchIds') selected JOIN batches b ON b.id = selected.value
        WHERE date(b.created_at, '+9 hours') = ?))) ORDER BY r.id DESC LIMIT 1`).get(date, date);
  return run ? invoiceDetail(db, run.id) : null;
}

export function reviseInvoiceItems(db, id, { changes = [], issueResolutions = [] } = {}) {
  return transaction(db, () => {
    const run = runRecord(db, id), detail = invoiceDetail(db, id);
    if (detail.rematchRequired) throw new Error('① 네이버 전체 발송 대상을 확인하도록 매칭 방식이 바뀌었습니다. 같은 ①·③ 파일을 다시 매칭해 주세요.');
    if (!Array.isArray(changes) || !Array.isArray(issueResolutions) || (!changes.length && !issueResolutions.length)) throw new Error('저장할 송장 검토 내용을 확인해 주세요.');
    const issues = detail.issues, seen = new Set();
    for (const resolution of issueResolutions) {
      const found = issues.find(warning => warning.key === resolution?.key);
      if (!found || seen.has(found.key) || (resolution.note !== undefined && (typeof resolution.note !== 'string' || resolution.note.length > 1000))) {
        throw new Error('경고 확인 내용의 형식과 중복 여부를 확인해 주세요.');
      }
      if (found.kind === 'registration_recheck') throw new Error('이 경고는 등록 상태를 다시 조회해야 확인할 수 있습니다.');
      seen.add(found.key); found.resolved = true;
      if (resolution.note !== undefined) found.note = resolution.note.trim();
    }
    const prepared = [], ids = new Set();
    for (const change of changes) {
      const item = detail.items.find(row => row.id === change?.id);
      if (!item || ids.has(item.id) || !['include', 'hold', 'exclude'].includes(change.decision)
        || typeof change.note !== 'string' || change.note.length > 1000) throw new Error('변경할 상품주문과 처리 결정을 확인해 주세요.');
      ids.add(item.id);
      const trackingNumber = change.trackingNumber === undefined ? item.trackingNumber : idText(change.trackingNumber);
      if (trackingNumber !== item.trackingNumber && (!change.note.trim() || !item.physicalShipments.some(parcel => parcel.valid === true && parcel.trackingNumber === trackingNumber))) {
        throw new Error('유효한 후보 송장을 선택하고 변경 사유를 입력해 주세요.');
      }
      const warnings = [...issues, ...detail.issues.filter(warning => !issues.some(saved => saved.key === warning.key))]
        .filter(warning => item.issues.includes(warning.key));
      if (change.decision === 'include' && (!trackingNumber || !item.internalId || warnings.some(warning => warning.blocking || !warning.resolved))) {
        throw new Error('연결 근거가 불명확하거나 해결하지 않은 경고가 있는 항목은 보류 또는 제외해 주세요.');
      }
      prepared.push({ item, decision: change.decision, note: change.note.trim(), trackingNumber });
    }
    for (const warning of issues) {
      const related = detail.items.filter(item => item.issues.includes(warning.key));
      const reviewed = related.map(item => prepared.find(change => change.item.id === item.id) || item);
      if (related.length && reviewed.every(item => item.decision !== 'include')
        && prepared.some(change => related.some(item => item.id === change.item.id) && change.note)) {
        warning.resolved = true;
        warning.note = prepared.find(change => related.some(item => item.id === change.item.id) && change.note).note;
      }
    }
    db.prepare('UPDATE invoice_runs SET issues_json = ? WHERE id = ?').run(JSON.stringify(issues.map(({ reviewRequired, ...warning }) => warning)), run.id);
    const update = db.prepare(`UPDATE invoice_items SET decision = ?, note = ?, tracking_number = ?,
      registration_state = CASE WHEN tracking_number <> ? THEN 'unchecked' ELSE registration_state END,
      status_checked_at = CASE WHEN tracking_number <> ? THEN NULL ELSE status_checked_at END WHERE id = ? AND run_id = ?`);
    const revision = db.prepare('INSERT INTO invoice_revisions (item_id, before_json, after_json) VALUES (?, ?, ?)');
    for (const change of prepared) {
      const before = { decision: change.item.decision, note: change.item.note, trackingNumber: change.item.trackingNumber };
      const after = { decision: change.decision, note: change.note, trackingNumber: change.trackingNumber };
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      update.run(after.decision, after.note, after.trackingNumber, after.trackingNumber, after.trackingNumber, change.item.id, run.id);
      revision.run(change.item.id, JSON.stringify(before), JSON.stringify(after));
    }
    return invoiceDetail(db, run.id);
  });
}

function createInvoiceExport(db, id, rebuild = false) {
  const detail = invoiceDetail(db, id), included = detail.items.filter(item => item.decision === 'include');
  if (detail.scopeRequired) throw new Error('저장 출고 작업을 선택해 송장을 새로 매칭한 뒤 엑셀을 만들어 주세요.');
  if (detail.rematchRequired) throw new Error('① 네이버 전체 발송 대상을 확인하도록 매칭 방식이 바뀌었습니다. 같은 ①·③ 파일을 다시 매칭해 주세요.');
  if (!included.length) throw new Error('엑셀로 만들 포함 항목이 없습니다.');
  if (detail.issues.some(warning => warning.reviewRequired && (!warning.resolved || (warning.blocking && included.some(item => item.issues.includes(warning.key)))))) {
    throw new Error('경고를 확인한 뒤 연결이 불명확한 항목을 보류·제외해 주세요.');
  }
  if (included.some(item => item.registrationState === 'conflict')) throw new Error('네이버 조회와 충돌하는 항목을 먼저 보류·제외해 주세요.');
  const pending = rebuild ? included : included.filter(item => item.registrationState !== 'complete' && !item.sourceRegistered);
  if (!pending.length) throw new Error('포함 항목의 동일 송장이 이미 등록되어 있어 중복 엑셀을 만들지 않습니다.');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['상품주문번호', '배송방법', '택배사', '송장번호'], ...pending.map(item => [item.productOrderId, '택배,등기,소포', detail.run.carrierName, item.trackingNumber]),
  ]), '발송처리');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const filename = `네이버_발송처리_${detail.run.id}${rebuild ? '_현재매칭재생성' : ''}.xlsx`;
  db.prepare(`UPDATE invoice_runs SET generated_at = COALESCE(generated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    generated_file = ?, generated_filename = ? WHERE id = ?`).run(buffer, filename, detail.run.id);
  return { buffer, filename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

export function exportInvoices(db, id) {
  return createInvoiceExport(db, id);
}

export function downloadInvoices(db, id, { rebuild = false } = {}) {
  const run = runRecord(db, id);
  if (!run.generated_at) throw new Error('엑셀을 처음 생성한 뒤 다시 다운로드해 주세요.');
  if (rebuild) return createInvoiceExport(db, id, true);
  if (!run.generated_file?.length) {
    const error = new Error('이전 생성 파일의 원본을 보관하지 않은 내역입니다. 현재 저장된 매칭으로 다시 만들기를 선택해 주세요.');
    error.code = 'saved_file_missing';
    throw error;
  }
  return { buffer: Buffer.from(run.generated_file), filename: run.generated_filename || `네이버_발송처리_${run.id}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

function outsideRemoteResult(rows, response, productOrderIds) {
  const unknown = { state: 'unknown', reason: '네이버 등록 상태 응답이 불완전합니다. 다시 확인해 주세요.', evidence: [] };
  if (!Array.isArray(response) || response.length !== productOrderIds.length
    || new Set(response.map(item => item?.productOrderId)).size !== productOrderIds.length
    || response.some(item => !productOrderIds.includes(item?.productOrderId)
      || item.orderId !== rows[0].orderId || typeof item.status !== 'string' || !item.status
      || !Number.isSafeInteger(item.remainQuantity) || item.remainQuantity < 0
      || typeof item.trackingNumber !== 'string' || typeof item.deliveryCompanyCode !== 'string')) return unknown;
  const evidence = response.map(item => ({ productOrderId: item.productOrderId, orderId: item.orderId, status: item.status,
    remainQuantity: item.remainQuantity, trackingNumber: item.trackingNumber, deliveryCompanyCode: item.deliveryCompanyCode,
    claimStatus: text(item.claimStatus), isWrongTrackingNumber: item.isWrongTrackingNumber === true }));
  const result = (state, reason) => ({ state, reason, evidence });
  if (response.every(item => ['CANCELED', 'CANCELLED'].includes(item.status) && item.remainQuantity === 0)) return result('canceled', '네이버에서 모든 상품주문의 취소 완료를 확인했습니다.');
  if (response.every(item => item.status === 'RETURNED' && item.remainQuantity === 0)) return result('returned', '네이버에서 모든 상품주문의 반품 완료를 확인했습니다.');
  if (response.some(item => item.isWrongTrackingNumber === true || item.deliveryStatus === 'WRONG_INVOICE'
    || text(item.claimStatus) && !['CANCEL_REJECT', 'RETURN_REJECT', 'EXCHANGE_REJECT'].includes(item.claimStatus))) {
    return result('attention', '송장 오류 또는 취소·반품·교환 상태를 확인해 주세요.');
  }
  if (response.every(item => item.status === 'PAYED' && item.remainQuantity > 0 && !item.trackingNumber)) {
    return result('pending', '주문 누락 가능성있음');
  }
  if (!response.every(item => registeredStatuses.has(item.status) && item.remainQuantity > 0
    && idText(item.trackingNumber) && text(item.deliveryCompanyCode))) return result('attention', '일부 상품의 등록 상태 또는 송장을 확인해 주세요.');
  if (new Set(response.map(item => JSON.stringify([item.deliveryCompanyCode, item.trackingNumber]))).size !== 1) {
    return result('attention', '상품별 등록 송장이 달라 내부 출고와의 관계를 확인해야 합니다.');
  }
  if (response.some(item => typeof item.recipient !== 'string' || !item.recipient || typeof item.phone !== 'string' || !item.phone
    || typeof item.address !== 'string' || !item.address || typeof item.detailAddress !== 'string')) return unknown;
  if (!rows.every(row => response.every(item => compact(item.recipient) === compact(row.recipient)
    && compact(item.address + ' ' + item.detailAddress) === compact(row.address)
    && (phone(item.phone) === phone(row.phone) || phone(item.phone).startsWith('050') || phone(row.phone).startsWith('050'))))) {
    return result('attention', '네이버와 저장 주문의 수취 정보가 달라 출고 연결을 확인해야 합니다.');
  }
  return result('external_registered', '네이버 등록 확인 완료');
}

export async function refreshOutsideInvoiceStatus(db, id, naver) {
  const run = runRecord(db, id), scope = run.scope_json ? JSON.parse(run.scope_json) : null, saved = legacyRows(db);
  const candidates = outsideCandidates(scope, saved);
  if (!candidates.length) return invoiceDetail(db, id);
  const started = new Date().toISOString(), snapshot = hash(candidates.map(row => outsideBinding(row, saved)).sort());
  const pending = candidates.map(row => ({ rowId: row.source.rowId, orderId: row.orderId, binding: outsideBinding(row, saved),
    state: 'unknown', reason: '네이버 등록 상태를 확인 중입니다.', productOrderIds: [], trackingNumbers: [], evidence: [], checkedAt: null }));
  const checkId = transaction(db, () => {
    const checkingId = Number(db.prepare('INSERT INTO invoice_checks (run_id, started_at) VALUES (?, ?)').run(run.id, started).lastInsertRowid);
    db.prepare('UPDATE invoice_runs SET scope_json = ? WHERE id = ?').run(JSON.stringify({ ...scope,
      outsideOrders: pending, outsideBatchIds: [...new Set(candidates.map(row => row.source.batchId))], outsideCheckId: checkingId, outsideCheckedAt: null }), run.id);
    return checkingId;
  });
  const byOrder = new Map();
  for (const row of candidates) {
    if (!byOrder.has(row.orderId)) byOrder.set(row.orderId, []);
    byOrder.get(row.orderId).push(row);
  }
  const results = [];
  for (const [orderId, rows] of byOrder) {
    let result = { state: 'unknown', reason: '네이버 등록 상태를 조회하지 못했습니다. 다시 확인해 주세요.', evidence: [] }, productOrderIds = [];
    try {
      if (typeof naver?.getProductOrderIds === 'function' && typeof naver?.queryProductOrders === 'function') {
        const ids = await naver.getProductOrderIds(orderId);
        if (Array.isArray(ids) && ids.length && ids.length <= 10000 && new Set(ids).size === ids.length
          && ids.every(value => typeof value === 'string' && idText(value) && value === idText(value))) {
          productOrderIds = ids;
          result = outsideRemoteResult(rows, await naver.queryProductOrders(ids), ids);
        }
      }
    } catch { /* 인증·응답 오류는 이번 파일의 정상 매칭·엑셀 생성을 막지 않습니다. */ }
    for (const row of rows) {
      let rowResult = result;
      if (result.state === 'external_registered') {
        const sourceConflict = !row.internalId || conflictingLegacy(saved, row.internalId);
        // 주문 전체의 등록 증거를 다른 내부 출고나 수취 정보에 잘못 적용하지 않습니다.
        if (sourceConflict) rowResult = { ...result, state: 'attention', reason: '저장 출고번호의 주문 연결 근거를 확인해 주세요.' };
      }
      results.push({ ...pending.find(item => item.rowId === row.source.rowId), ...rowResult, productOrderIds,
        trackingNumbers: rowResult.state === 'external_registered' ? [...new Set(result.evidence.map(item => item.trackingNumber))] : [] });
    }
  }
  const finished = new Date().toISOString(), latestRun = runRecord(db, id), latestScope = JSON.parse(latestRun.scope_json), current = legacyRows(db);
  const currentCandidates = outsideCandidates(latestScope, current);
  const currentSnapshot = hash(currentCandidates.map(row => outsideBinding(row, current)).sort());
  const latestDraft = run.draft_key && db.prepare('SELECT id FROM invoice_runs WHERE draft_key = ? ORDER BY id DESC LIMIT 1').get(run.draft_key);
  const stale = latestScope.outsideCheckId !== checkId || snapshot !== currentSnapshot || latestDraft && latestDraft.id !== run.id
    || invoiceDetail(db, id).issues.some(warning => warning.kind === 'source_changed');
  const checked = results.map(result => stale ? { ...result, state: 'unknown', reason: '조회 중 주문 근거가 바뀌었습니다. 다시 확인해 주세요.',
    evidence: [], productOrderIds: [], trackingNumbers: [], checkedAt: null } : { ...result, checkedAt: finished });
  transaction(db, () => {
    if (latestScope.outsideCheckId === checkId) db.prepare('UPDATE invoice_runs SET scope_json = ? WHERE id = ?').run(JSON.stringify({ ...latestScope,
      outsideOrders: checked, outsideBatchIds: [...new Set(currentCandidates.map(row => row.source.batchId))], outsideCheckedAt: stale ? null : finished }), id);
    db.prepare('UPDATE invoice_checks SET status = ?, finished_at = ?, results_json = ?, error = ? WHERE id = ?')
      .run(stale || checked.some(result => result.state === 'unknown') ? 'failed' : 'succeeded', finished,
        JSON.stringify(checked.map(({ binding, ...result }) => ({ ...result, kind: 'outside_naver' }))),
        stale ? '조회 중 주문 근거가 바뀌었습니다.' : checked.some(result => result.state === 'unknown') ? '일부 주문의 등록 여부를 확인하지 못했습니다.' : null, checkId);
  });
  return invoiceDetail(db, id);
}

export async function refreshInvoiceStatus(db, id, naver) {
  const run = runRecord(db, id), detail = invoiceDetail(db, id);
  if (detail.rematchRequired) throw new Error('① 네이버 전체 발송 대상을 확인하도록 매칭 방식이 바뀌었습니다. 같은 ①·③ 파일을 다시 매칭해 주세요.');
  if (detail.scopeRequired) throw new Error('저장 출고 작업을 선택해 송장을 새로 매칭한 뒤 등록 상태를 조회해 주세요.');
  const records = db.prepare('SELECT * FROM invoice_items WHERE run_id = ? ORDER BY id').all(run.id);
  if (!records.length) throw new Error('등록 상태를 조회할 연결된 네이버 상품주문이 없습니다.');
  const started = new Date().toISOString();
  const checkId = transaction(db, () => {
    db.prepare('UPDATE invoice_runs SET status_checked_at = NULL WHERE id = ?').run(run.id);
    db.prepare("UPDATE invoice_items SET registration_state = 'unchecked', status_checked_at = NULL WHERE run_id = ?").run(run.id);
    return Number(db.prepare('INSERT INTO invoice_checks (run_id, started_at) VALUES (?, ?)').run(run.id, started).lastInsertRowid);
  });
  try {
    if (!naver || typeof naver.queryProductOrders !== 'function') throw new InvoiceStatusError('등록 상태 조회를 사용할 수 없습니다.');
    const response = await naver.queryProductOrders(records.map(item => item.product_order_id));
    if (!Array.isArray(response) || response.length !== records.length || new Set(response.map(row => row?.productOrderId)).size !== records.length
      || records.some(record => !response.some(row => row?.productOrderId === record.product_order_id))) throw new InvoiceStatusError('등록 상태 응답에 누락·중복 상품주문이 있습니다.');
    const result = records.map(record => {
      const remote = response.find(row => row.productOrderId === record.product_order_id), expected = JSON.parse(record.expected_json);
      if (typeof remote.orderId !== 'string' || !remote.orderId || typeof remote.status !== 'string' || !remote.status
        || !Number.isSafeInteger(remote.remainQuantity) || remote.remainQuantity < 0 || typeof remote.recipient !== 'string' || !remote.recipient
        || typeof remote.phone !== 'string' || !remote.phone || typeof remote.address !== 'string' || !remote.address
        || typeof remote.detailAddress !== 'string' || typeof remote.deliveryCompanyCode !== 'string'
        || typeof remote.trackingNumber !== 'string') throw new InvoiceStatusError('등록 상태 응답의 주문·주소·택배사 필드가 불완전합니다.');
      const problems = [];
      if (remote.orderId !== record.order_id) problems.push('order_changed');
      const recipientMatches = compact(remote.recipient) === compact(expected.recipient)
        && compact(remote.address + ' ' + remote.detailAddress) === compact(expected.address);
      const registeredTracking = registeredStatuses.has(remote.status) && remote.trackingNumber === record.tracking_number
        && remote.deliveryCompanyCode === run.carrier_code && Boolean(record.tracking_number);
      const differentPhone = phone(remote.phone) !== phone(expected.phone);
      const relayPhone = differentPhone && (phone(remote.phone).startsWith('050') || phone(expected.phone).startsWith('050'))
        && registeredTracking && recipientMatches;
      if (!recipientMatches || (differentPhone && !relayPhone)) problems.push('recipient_changed');
      if (remote.remainQuantity !== expected.quantity) problems.push('quantity_changed');
      if (canceled(remote.status) || !remote.remainQuantity || /CANCEL_REQUEST|CANCELING|RETURN_REQUEST|EXCHANGE_REQUEST/.test(text(remote.claimStatus))) problems.push('claim');
      if (remote.isWrongTrackingNumber === true || remote.deliveryStatus === 'WRONG_INVOICE') problems.push('wrong_tracking');
      if (remote.trackingNumber && (remote.trackingNumber !== record.tracking_number || remote.deliveryCompanyCode !== run.carrier_code)) problems.push('tracking_conflict');
      if (registeredStatuses.has(remote.status) && (!remote.trackingNumber || !remote.deliveryCompanyCode)) problems.push('registration_incomplete');
      const complete = !problems.length && registeredTracking;
      if (!complete && !problems.length && remote.status !== 'PAYED') problems.push('status');
      return { id: record.id, state: problems.length ? 'conflict' : complete ? 'complete' : 'pending', problems,
        note: complete && relayPhone ? '송장 등록 일치. 원본/조회 연락처는 안심번호 등으로 직접 대조할 수 없습니다.' : '',
        productOrderId: record.product_order_id, trackingNumber: remote.trackingNumber, deliveryCompanyCode: remote.deliveryCompanyCode,
        status: remote.status, remainQuantity: remote.remainQuantity };
    });
    const latest = invoiceDetail(db, run.id);
    if (latest.items.some(item => item.superseded) || latest.issues.some(warning => warning.kind === 'source_changed')
      || latest.items.some(item => item.trackingNumber !== detail.items.find(before => before.id === item.id)?.trackingNumber)) {
      throw new InvoiceStatusError('조회 중 매칭 근거나 대표 송장이 바뀌었습니다. 최신 작업에서 다시 조회해 주세요.');
    }
    const finished = new Date().toISOString();
    transaction(db, () => {
      const update = db.prepare('UPDATE invoice_items SET registration_state = ?, status_checked_at = ?, status_json = ? WHERE id = ? AND run_id = ?');
      for (const item of result) update.run(item.state, finished, JSON.stringify(item), item.id, run.id);
      db.prepare('UPDATE invoice_runs SET status_checked_at = ? WHERE id = ?').run(finished, run.id);
      db.prepare("UPDATE invoice_checks SET status = 'succeeded', finished_at = ?, results_json = ? WHERE id = ?")
        .run(finished, JSON.stringify(result), checkId);
      const checked = invoiceDetail(db, run.id);
      for (const item of checked.items) if (item.registrationRecheck && item.statusFresh && ['pending', 'complete'].includes(item.registrationState)
        && item.decision === 'hold' && !item.note && !db.prepare('SELECT 1 FROM invoice_revisions WHERE item_id = ? LIMIT 1').get(item.id)
        && !checked.issues.some(warning => item.issues.includes(warning.key) && (warning.blocking || !warning.resolved))) {
        db.prepare("UPDATE invoice_items SET decision = 'include' WHERE id = ?").run(item.id);
      }
    });
    return invoiceDetail(db, run.id);
  } catch (error) {
    const message = error instanceof InvoiceStatusError ? error.message : '네이버 등록 상태를 조회하지 못했습니다. 인증·네트워크를 확인한 뒤 다시 시도해 주세요.';
    db.prepare("UPDATE invoice_checks SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(new Date().toISOString(), message, checkId);
    throw new Error(message);
  }
}

export function shipmentInvoiceStates(db, internalIds) {
  const result = Object.fromEntries(internalIds.map(id => [id, 'unavailable']));
  if (!internalIds.length) return result;
  const all = db.prepare(`SELECT i.*, r.mall, r.store FROM invoice_items i JOIN invoice_runs r ON r.id = i.run_id ORDER BY i.id DESC`).all();
  const latest = new Map();
  const details = new Map();
  const saved = legacyRows(db), outsideByRow = new Map();
  const outsideRuns = db.prepare(`SELECT id FROM invoice_runs WHERE json_array_length(scope_json, '$.outsideOrders') > 0 ORDER BY id DESC`).all();
  for (const run of outsideRuns) {
    const scope = JSON.parse(runRecord(db, run.id).scope_json);
    if (!scope.outsideOrders.some(proof => saved.some(row => row.source.rowId === proof.rowId && internalIds.includes(row.internalId)))) continue;
    if (!details.has(run.id)) details.set(run.id, invoiceDetail(db, run.id));
    for (const order of details.get(run.id).outsideOrders) if (internalIds.includes(order.internalId) && !outsideByRow.has(order.rowId)) {
      outsideByRow.set(order.rowId, { ...order, runId: run.id });
    }
  }
  for (const item of all) {
    const key = JSON.stringify([item.mall, item.store, item.product_order_id]);
    if (!latest.has(key)) latest.set(key, item);
  }
  for (const internalId of internalIds) {
    const items = all.filter(item => item.internal_id === internalId
      || JSON.parse(item.shipments_json).some(parcel => parcel.internalId === internalId));
    const sources = saved.filter(row => row.internalId === internalId), outside = sources.map(row => outsideByRow.get(row.source.rowId));
    if (outside.some(Boolean) && outside.every(order => order && order.runId >= Math.max(0, ...items.map(item => item.run_id)))) {
      result[internalId] = !conflictingLegacy(saved, internalId) && sources.every(row => row.supported && row.orderId)
        && outside.every(order => order.externalRegistration) ? 'complete' : 'pending';
      continue;
    }
    if (!items.length) continue;
    const relevant = [...new Map(items.map(item => [JSON.stringify([item.mall, item.store, item.product_order_id]), latest.get(JSON.stringify([item.mall, item.store, item.product_order_id]))])).values()];
    result[internalId] = 'pending';
    if (relevant.every(item => {
      if (!details.has(item.run_id)) details.set(item.run_id, invoiceDetail(db, item.run_id));
      const detail = details.get(item.run_id), current = detail.items.find(row => row.id === item.id);
      return current?.physicalShipments.some(parcel => parcel.valid === true && parcel.internalId === internalId)
        && current.decision === 'include' && current.statusFresh && current.registrationState === 'complete'
        && current.physicalShipments.some(parcel => parcel.valid === true && parcel.trackingNumber === current.trackingNumber)
        && !detail.issues.some(warning => current.issues.includes(warning.key) && (warning.blocking || !warning.resolved));
    })) result[internalId] = 'complete';
  }
  return result;
}
