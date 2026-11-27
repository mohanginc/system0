import path from 'node:path';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';

const digest = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' ? value.trim() : '';
const populated = value => value != null && String(value).trim() !== '';
const headers = {
  productOrderId: '상품주문번호', orderId: '주문번호', shippingGroupId: '묶음배송번호', externalOptionId: '옵션ID',
  externalProductId: '노출상품ID', originalName: '등록상품명', optionName: '등록옵션명', sellerProductCode: '업체상품코드',
  sourceBarcode: '바코드', orderedAt: '주문일', quantity: '구매수(수량)', unitPrice: '옵션판매가(판매단가)',
  paymentAmount: '결제액', shippingFeeAmount: '배송비', shippingExtraAmount: '도서산간추가배송비', shippingFeeType: '배송비구분',
  recipient: '수취인이름', address: '수취인주소', zip: '우편번호', trackingNumber: '운송장번호', carrier: '택배사',
  shippedAt: '출고일(발송일)', deliveredAt: '배송완료일', confirmedAt: '구매확정일자', status: '주문상태',
  recipientPhone: '수취인전화번호', shippingMemo: '배송메세지',
};
const required = ['orderId', 'shippingGroupId', 'externalOptionId', 'originalName', 'quantity', 'recipient', 'address', 'trackingNumber', 'shippedAt'];
const readyStatuses = new Set(['결제완료', '상품준비중', '배송요청', '발주확인', '출고대기', '배송대기', '발송대기', '운송장미등록']);
const closedStatuses = new Set(['배송중', '배송완료', '구매확정', '출고완료', '발송완료', '취소완료', '반품완료', '취소']);

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function identifier(value, label, { optional = false } = {}) {
  if (!populated(value) && optional) return '';
  const id = Number.isSafeInteger(value) && value >= 0 ? String(value) : text(value);
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(id)) throw invalid(`${label}를 확인해 주세요. 긴 번호는 엑셀에 텍스트로 저장해야 합니다.`);
  return id;
}

function integer(value, label) {
  if (!populated(value)) return null;
  const cell = text(value), number = typeof value === 'number' ? value
    : /^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(cell) ? Number(cell.replaceAll(',', '')) : NaN;
  if (!Number.isSafeInteger(number)) throw invalid(`${label}은 원본의 정수 값으로 입력해 주세요.`);
  return number;
}

function orderDate(value, date1904) {
  if (!populated(value)) return null;
  let cell = text(value);
  if (typeof value === 'number') {
    const parts = XLSX.SSF.parse_date_code(value, { date1904 });
    if (parts) {
      const pad = value => String(value).padStart(2, '0');
      cell = `${parts.y}-${pad(parts.m)}-${pad(parts.d)} ${pad(parts.H)}:${pad(parts.M)}:${pad(parts.S)}`;
    }
  }
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(cell);
  const day = match ? Date.parse(`${match[1]}T00:00:00Z`) : NaN;
  const date = match ? Date.parse(`${match[1]}T${match[2] || '00:00'}:${match[3] || '00'}+09:00`) : NaN;
  if (!Number.isFinite(date) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) {
    throw invalid('주문일을 확인해 주세요.');
  }
  return new Date(date).toISOString();
}

const isShipmentEvidence = value => populated(value) && !/^(?:-|없음|미입력)$/u.test(String(value).trim());

function processRow({ recipientPhone, shippingMemo, ...row }, location, date1904) {
  const orderId = identifier(row.orderId, '주문번호'), shippingGroupId = identifier(row.shippingGroupId, '묶음배송번호');
  const externalOptionId = identifier(row.externalOptionId, '옵션ID');
  const nativeProductOrderId = identifier(row.productOrderId, '상품주문번호', { optional: true });
  const productOrderId = nativeProductOrderId || `cp-${digest(JSON.stringify([orderId, shippingGroupId, externalOptionId]))}`;
  const originalName = text(row.originalName), quantity = integer(row.quantity, '구매수');
  const rawStatus = text(row.status).replace(/\s/gu, '');
  const shipped = [row.shippedAt, row.deliveredAt, row.confirmedAt].some(isShipmentEvidence) || closedStatuses.has(rawStatus);
  const held = isShipmentEvidence(row.trackingNumber) || Boolean(rawStatus && !readyStatuses.has(rawStatus));
  const state = shipped ? 'closed' : held ? 'hold' : 'pending';
  const status = rawStatus || (shipped ? 'SHIPPED' : held ? 'TRACKING_PRESENT' : 'AWAITING_SHIPMENT');
  if (!originalName || quantity === null || quantity < 0 || (state === 'pending' && quantity === 0)) {
    throw invalid('등록상품명과 구매수를 확인해 주세요.');
  }
  const tel1 = text(recipientPhone);
  const memo = text(shippingMemo) ? shippingMemo : '';
  const shippingAddress = { name: text(row.recipient), tel1, baseAddress: text(row.address), detailedAddress: '',
    zipCode: typeof row.zip === 'number' && Number.isSafeInteger(row.zip) ? String(row.zip).padStart(5, '0') : text(row.zip) };
  const financial = { orderedQuantity: quantity, unitPrice: integer(row.unitPrice, '옵션판매가'), paymentAmount: integer(row.paymentAmount, '결제액'),
    shippingFeeAmount: integer(row.shippingFeeAmount, '배송비'), shippingExtraAmount: integer(row.shippingExtraAmount, '도서산간 추가배송비') };
  const evidenceHash = digest(JSON.stringify({ ...row, ...(tel1 ? { recipientPhone: tel1 } : {}), ...(memo ? { shippingMemo: memo } : {}) }));
  return { productOrderId, nativeProductOrderId, orderId, shippingGroupId, externalOptionId, quantity, originalName,
    productName: originalName, optionName: text(row.optionName), status, state, financial, orderedAt: orderDate(row.orderedAt, date1904),
    externalProductId: identifier(row.externalProductId, '노출상품ID', { optional: true }),
    sellerProductCode: text(row.sellerProductCode), sourceBarcode: typeof row.sourceBarcode === 'number' && Number.isSafeInteger(row.sourceBarcode)
      ? String(row.sourceBarcode) : text(row.sourceBarcode),
    sourcePayload: { location, evidenceHash, columns: row, shippingAddress, shippingMemo: memo } };
}

export function parseCoupangOrders(file) {
  const filename = path.basename(text(file?.originalname));
  if (!/\.xlsx$/iu.test(filename) || !Buffer.isBuffer(file?.buffer) || file.buffer.subarray(0, 2).toString() !== 'PK') {
    throw invalid('쿠팡 주문 .xlsx 파일을 선택해 주세요.');
  }
  let workbook;
  try { workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: false }); }
  catch { throw invalid('쿠팡 주문 엑셀을 읽을 수 없습니다.'); }
  const archiveSha256 = digest(file.buffer), orders = [], identities = new Set();
  let matchedSheet = false;
  for (const sheet of workbook.SheetNames) {
    const tab = workbook.Sheets[sheet];
    const rows = XLSX.utils.sheet_to_json(tab, { header: 1, defval: null, raw: true, blankrows: true });
    const headerIndex = rows.slice(0, 12).findIndex(row => {
      const present = new Set(row.map(value => text(value).replace(/\s/gu, '')));
      return required.every(field => present.has(headers[field]));
    });
    if (headerIndex < 0) continue;
    matchedSheet = true;
    const rowNumber = tab['!ref'] ? XLSX.utils.decode_range(tab['!ref']).s.r + 1 : 1;
    const columns = rows[headerIndex].map(value => text(value).replace(/\s/gu, ''));
    const offsets = Object.entries(headers).map(([key, header]) => {
      if (columns.indexOf(header) !== columns.lastIndexOf(header)) throw invalid('쿠팡 주문 엑셀에 같은 열 이름이 두 개 이상 있습니다.');
      return [key, columns.indexOf(header)];
    });
    for (let index = headerIndex + 1; index < rows.length; index++) {
      if (!rows[index].some(populated)) continue;
      const location = { filename, archiveSha256, sheet, row: rowNumber + index };
      const values = Object.fromEntries(offsets.map(([key, offset]) => [key, offset < 0 ? null : rows[index][offset]]));
      let order;
      try { order = processRow(values, location, Boolean(workbook.Workbook?.WBProps?.date1904)); }
      catch (error) { throw invalid(`쿠팡 주문 파일 ${location.row}행: ${error.message}`); }
      if (identities.has(order.productOrderId)) throw invalid(`쿠팡 주문 파일 ${location.row}행의 주문·묶음배송·옵션 번호가 중복됩니다.`);
      identities.add(order.productOrderId);
      orders.push(order);
    }
  }
  if (!matchedSheet) throw invalid('쿠팡 주문 엑셀에 필요한 주문·배송·상품 열을 찾을 수 없습니다.');
  if (!orders.length) throw invalid('쿠팡 주문 엑셀에 저장할 주문 행이 없습니다.');
  return orders;
}
