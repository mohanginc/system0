import { shipmentInvoiceStates } from './invoices.mjs';

const dayMs = 24 * 60 * 60 * 1000, kstOffset = 9 * 60 * 60 * 1000;
const today = () => new Date(Date.now() + kstOffset).toISOString().slice(0, 10);
const text = value => value == null ? '' : String(value).normalize('NFC').trim();
const header = value => text(value).replace(/\s/g, '');
const compact = value => text(value).replace(/\s/g, '');

function midnight(date) {
  const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0000')
    ? new Date(date + 'T00:00:00.000Z') : new Date(NaN);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('출고 조회 날짜는 실제 존재하는 날짜를 YYYY-MM-DD 형식으로 지정해 주세요.');
  }
  return parsed.getTime();
}

export function neighborhood(address) {
  const source = text(address);
  const regions = /^(서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:도|특별자치도)?|충북|충청북도|충남|충청남도|전북|전라북도|전북특별자치도|전남|전라남도|경북|경상북도|경남|경상남도|제주(?:도|특별자치도)?)$/;
  const administrative = /^[가-힣][가-힣0-9·]*(시|군|구|읍|면|동)$/;
  const building = /아파트|빌딩|건물|센터|타워|상가|관리동|기숙사/;
  const parts = [];
  for (const token of source.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean)) {
    if ((regions.test(token) || administrative.test(token)) && !building.test(token)) parts.push(token);
    else break;
  }
  for (const match of source.matchAll(/\(\s*([가-힣][가-힣0-9·]*동)(?=\s*[,)]|\s*$)/g)) {
    if (!building.test(match[1])) parts.push(match[1]);
  }
  return [...new Set(parts)].join(' ');
}

function sourceFields(raw, headerIndex) {
  const columns = (raw[headerIndex] || []).map(header);
  const column = names => {
    for (const name of names) { const index = columns.indexOf(name); if (index >= 0) return index; }
    return -1;
  };
  let order = column(['내부출고번호', '출고번호', '내부주문번호']);
  if (order < 0 && columns.includes('체결번호')) order = column(['주문번호']);
  return {
    order,
    recipient: column(['수취인명', '수취인', '받는분성명', '받는분', '수령인', '송화주']),
    phone: column(['수취인연락처1', '연락처1', '수취인전화번호', '전화번호', '받는분전화', '전화', '연락처']),
    address: column(['통합배송지', '수취인전체주소', '수취인주소', '전체주소', '배송지주소', '배송지', '주소', '기본배송지']),
  };
}

function shippingId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  return typeof value === 'string' ? value.trim() : '';
}

function invoiceSummary(states) {
  if (states.length && states.every(state => state === 'complete')) return 'complete';
  return states.some(state => state !== 'unavailable') ? 'pending' : 'unavailable';
}

export function shippingBoard(db, date = today(), batchId) {
  const start = midnight(date) - kstOffset;
  const batches = db.prepare(`SELECT b.id, b.name, b.created_at AS createdAt, count(r.id) AS rowCount
    FROM batches b LEFT JOIN rows r ON r.batch_id = b.id AND r.is_deleted = 0
    WHERE b.is_deleted = 0 AND b.created_at >= ? AND b.created_at < ? GROUP BY b.id ORDER BY b.id DESC`)
    .all(new Date(start).toISOString(), new Date(start + dayMs).toISOString());
  let selectedBatchId = null;
  if (batchId !== undefined) {
    if (!/^[1-9]\d*$/.test(String(batchId)) || !Number.isSafeInteger(Number(batchId))) throw new Error('출고 조회 작업 번호를 확인해 주세요.');
    selectedBatchId = Number(batchId);
    if (!batches.some(batch => batch.id === selectedBatchId)) throw new Error('선택한 날짜에 속한 작업을 선택해 주세요.');
  }
  const records = db.prepare(`SELECT r.id, r.batch_id, r.sheet_id, r.source_row, r.cleaned_name
    FROM rows r JOIN sheets s ON s.id = r.sheet_id JOIN batches b ON b.id = r.batch_id
    WHERE b.is_deleted = 0 AND r.is_deleted = 0 AND b.created_at >= ? AND b.created_at < ?
      ${selectedBatchId ? 'AND b.id = ?' : ''} ORDER BY r.id`)
    .all(new Date(start).toISOString(), new Date(start + dayMs).toISOString(), ...(selectedBatchId ? [selectedBatchId] : []));
  const sheets = new Map(), shipments = new Map(), issues = [];
  const readSheet = db.prepare('SELECT raw_json, header_index FROM sheets WHERE id = ?');
  let missingIdCount = 0;
  for (const record of records) {
    if (!sheets.has(record.sheet_id)) {
      const saved = readSheet.get(record.sheet_id), raw = JSON.parse(saved.raw_json);
      sheets.set(record.sheet_id, { raw, fields: sourceFields(raw, saved.header_index) });
    }
    const { raw, fields } = sheets.get(record.sheet_id), cells = raw[record.source_row - 1] || [];
    const rawId = cells[fields.order], orderId = shippingId(rawId);
    if (!orderId) {
      missingIdCount++;
      if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) {
        issues.push({ kind: 'unsafe_id', message: '작업 ' + record.batch_id + '의 원본 ' + record.source_row + '행 출고번호는 숫자 정밀도를 확인해야 합니다. 이 행은 중복 확인 없이 집계했습니다.' });
      }
    }
    const id = orderId ? 'order:' + orderId : 'row:' + record.id;
    if (!shipments.has(id)) shipments.set(id, []);
    const recipient = text(cells[fields.recipient]), phone = text(cells[fields.phone]), address = text(cells[fields.address]);
    shipments.get(id).push({ name: text(record.cleaned_name), recipient, phone, neighborhood: neighborhood(address),
      identity: JSON.stringify([compact(recipient), phone.replace(/[^0-9*]/g, ''), compact(address)]) });
  }
  const invoiceStates = shipmentInvoiceStates(db, [...shipments.keys()].filter(id => id.startsWith('order:')).map(id => id.slice(6)));
  const groups = new Map(), groupStates = new Map();
  let conflictCount = 0, unpreparedCount = 0;
  for (const [id, copies] of shipments) {
    const names = new Set(copies.map(row => row.name).filter(Boolean));
    const conflictingRecipient = new Set(copies.map(row => row.identity)).size > 1;
    const conflict = names.size > 1 || conflictingRecipient;
    const name = names.values().next().value || '';
    const key = conflict ? 'conflict' : name ? 'name:' + name : 'unprepared';
    if (conflict) {
      conflictCount++;
      issues.push({ kind: 'conflict', message: '동일 출고번호의 상품명 또는 수취인 정보가 달라 확인 필요 묶음으로 따로 집계했습니다.' });
    } else if (!name) unpreparedCount++;
    if (!groups.has(key)) groups.set(key, { key, name: conflict ? '중복 충돌 · 확인 필요' : name || '미정리',
      unprepared: !conflict && !name, needsAttention: conflict, count: 0, invoiceState: 'unavailable', shipments: [] });
    const group = groups.get(key), source = copies.find(row => row.name === name) || copies[0];
    let invoiceState = id.startsWith('order:') ? invoiceStates[id.slice(6)] || 'unavailable' : 'unavailable';
    if ((conflict || !name) && invoiceState === 'complete') invoiceState = 'pending';
    if (!groupStates.has(key)) groupStates.set(key, []);
    groupStates.get(key).push(invoiceState);
    group.count++;
    group.shipments.push({ id, recipient: conflictingRecipient ? '확인 필요' : source.recipient,
      phone: conflictingRecipient ? '' : source.phone, neighborhood: conflictingRecipient ? '' : source.neighborhood });
  }
  for (const group of groups.values()) group.invoiceState = invoiceSummary(groupStates.get(group.key));
  if (missingIdCount) issues.push({ kind: 'missing_id', message: '출고번호 없는 ' + missingIdCount + '행은 원본행별로 집계했으며 재업로드 중복 여부는 확인할 수 없습니다.' });
  const result = [...groups.values()].sort((a, b) => Number(a.unprepared || a.needsAttention) - Number(b.unprepared || b.needsAttention)
    || b.count - a.count || a.name.localeCompare(b.name, 'ko'));
  return { date, batches, selectedBatchId, groups: result,
    summary: { bundleCount: shipments.size, groupCount: result.length, unpreparedCount,
      duplicateCount: records.length - shipments.size, conflictCount, missingIdCount }, issues,
    invoiceState: invoiceSummary(result.map(group => group.invoiceState)) };
}

export function shippingDates(db, month = today().slice(0, 7)) {
  if (typeof month !== 'string' || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000')) {
    throw new Error('출고 달력 월은 YYYY-MM 형식으로 지정해 주세요.');
  }
  const start = midnight(month + '-01') - kstOffset;
  const next = new Date(start + kstOffset); next.setUTCMonth(next.getUTCMonth() + 1);
  const days = db.prepare(`SELECT date(created_at, '+9 hours') AS date, count(*) AS batchCount
    FROM batches WHERE is_deleted = 0 AND created_at >= ? AND created_at < ? GROUP BY date ORDER BY date`)
    .all(new Date(start).toISOString(), new Date(next.getTime() - kstOffset).toISOString())
    .map(day => ({ ...day, invoiceState: shippingBoard(db, day.date).invoiceState }));
  return { month, days };
}
