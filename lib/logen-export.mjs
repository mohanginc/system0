import * as XLSX from 'xlsx';
import { shippingBoard, shippingDayRange } from './shipping.mjs';
import { shippingAddressFromSource, shippingContact } from './shipping-contact.mjs';
import { dispatchReference } from './dispatch-reference.mjs';

const headers = ['송화주', '핸드폰', '전화번호', '주소', '선착불', '원상품명', '비고', '우편번호', '수량',
  '택배비', '비고', '가격', '쇼핑몰', '주문번호', '공급처', '체결번호', '맞춤여부', '상담메모'];
const text = value => typeof value === 'string' ? value.trim() : '';
const unique = values => [...new Set(values.filter(Boolean))];
const amount = value => {
  if (typeof value === 'string' && /^\d[\d,]*$/.test(value.trim())) value = Number(value.replaceAll(',', ''));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

function merchandiseValue(provider, product, quantity) {
  if (provider === 'coupang') {
    const unitPrice = amount(product.unitPrice);
    return unitPrice === null ? null : unitPrice * quantity;
  }
  const total = amount(product.remainProductAmount ?? product.totalProductAmount);
  const remaining = amount(product.remainQuantity ?? product.quantity);
  if (total !== null && remaining && quantity <= remaining) {
    if (quantity === remaining) return total;
    if (total % remaining === 0) return total / remaining * quantity;
  }
  return null;
}

function storedDispatchLines(db, from, to) {
  const lines = db.prepare(`SELECT b.id, b.contact_phone, b.shipping_memo, b.shipping_json, i.provider, i.quantity, o.store, o.order_id, s.source_json
    FROM order_dispatch_boxes b JOIN order_dispatch_items i ON i.dispatch_box_id = b.id
    JOIN order_intake_items o ON o.id = i.order_item_id
    LEFT JOIN order_intake_snapshots s ON s.id = (
      SELECT saved.id FROM order_intake_snapshots saved WHERE saved.item_id = i.order_item_id
        AND saved.recorded_at <= b.registered_at ORDER BY saved.recorded_at DESC, saved.id DESC LIMIT 1
    )
    WHERE b.registered_at >= ? AND b.registered_at < ? ORDER BY b.id, i.order_item_id`).all(from, to);
  const byBox = new Map();
  for (const line of lines) {
    if (!byBox.has(line.id)) byBox.set(line.id, []);
    const source = line.source_json ? JSON.parse(line.source_json) : {};
    const product = source.content?.productOrder ?? source.productOrder ?? source.columns ?? {};
    const orderId = (source.content?.order ?? source.order)?.orderId ?? source.columns?.orderId;
    byBox.get(line.id).push({ ...line, orderId: (Number.isSafeInteger(orderId) ? String(orderId) : text(orderId)) || line.order_id,
      address: line.shipping_json ? JSON.parse(line.shipping_json) : shippingAddressFromSource(source),
      memo: text(source.shippingMemo) || text(product.shippingMemo), price: merchandiseValue(line.provider, product, line.quantity) });
  }
  return byBox;
}

export function logenExport(db, date, format) {
  if (format !== undefined && format !== 'summary') throw new Error('로젠 엑셀 조회 형식을 확인해 주세요.');
  const range = shippingDayRange(date);
  const { registered } = shippingBoard(db, date);
  if (!registered.boxCount) {
    if (registered.totalBoxCount) throw Object.assign(new Error('취소 또는 보류 상자를 제외하면 로젠 엑셀에 넣을 상자가 없습니다.'), { status: 409 });
    throw Object.assign(new Error('선택한 날짜에 로젠 엑셀로 받을 등록 출고가 없습니다.'), { status: 404 });
  }

  const names = new Map(registered.groups.flatMap(group => group.shipments.map(shipment => [shipment.boxId, group.name])));
  const byBox = storedDispatchLines(db, ...range), rows = [], incomplete = [];
  for (const box of registered.boxes) {
    if (box.dispatchState !== 'ready') continue;
    const lines = byBox.get(box.id), first = lines[0];
    const address = first.address, street = [text(address?.baseAddress), text(address?.detailedAddress)].filter(Boolean).join(' ');
    const phone = text(first.contact_phone) || shippingContact(address).phone;
    const secondPhone = [text(address?.tel2), text(address?.tel1)].find(value => value && value !== phone) ?? '';
    const name = names.get(box.id);
    if (!box.recipient || !phone || !street || !name) { incomplete.push(box.id); continue; }

    const orderKeys = new Set(lines.map(line => JSON.stringify([line.provider, line.store, line.orderId])));
    const orderId = orderKeys.size === 1 ? first.orderId : '';
    const contentPrice = lines.every(line => line.price !== null) ? lines.reduce((sum, line) => sum + line.price, 0) : null;
    const memo = first.shipping_json ? text(address.memo) : unique([text(first.shipping_memo), ...lines.map(line => line.memo)]).join(' / ');
    // Legacy shipment references are 18-digit text. The 9 after the date keeps these IDs separate from legacy timestamps.
    const boxNumber = dispatchReference(date, box.id);
    rows.push([box.recipient, secondPhone, phone, street, '신용', name, memo, text(address?.zipCode), '1', '3800', '',
      Number.isSafeInteger(contentPrice) ? String(contentPrice) : '', '베이비스텔라', boxNumber, 'rus00', orderId, '0', '']);
  }
  if (incomplete.length) throw Object.assign(new Error(
    `등록 상자 ${incomplete.length}개의 수취인·전화번호·주소 또는 상품명을 확인할 수 없어 로젠 엑셀을 만들 수 없습니다. 상자 ${incomplete.slice(0, 10).join(', ')}`),
  { status: 409 });

  const filename = `로젠_업로드_${date}.xlsx`;
  if (format === 'summary') return { date, boxCount: rows.length, filename };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'rus00');
  return { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
}
