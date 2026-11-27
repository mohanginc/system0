import { parseCoupangOrders } from './coupang-orders.mjs';
import { transaction } from './database.mjs';
import { dispatchContactSnapshots, shippingAddressFromSource } from './shipping-contact.mjs';
import { shippingDayRange } from './shipping.mjs';

const recipientKey = value => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
const sourceKey = (location, productOrderId) => JSON.stringify([location.archiveSha256, location.sheet, location.row, productOrderId]);

function recoverDispatchField(db, file, date, { expectedBoxes, verifyOnly = false }, column, value, label) {
  const strict = expectedBoxes !== undefined;
  if ((strict && (!Number.isSafeInteger(expectedBoxes) || expectedBoxes <= 0)) || (verifyOnly && !strict)) {
    throw new Error('복원할 출고 상자 수를 확인해 주세요.');
  }
  const range = shippingDayRange(date);
  const fromWorkbook = new Map(parseCoupangOrders(file).map(order => [
    sourceKey(order.sourcePayload.location, order.productOrderId), order.sourcePayload,
  ]));
  function recover() {
    const matches = [];
    for (const box of dispatchContactSnapshots(db, ...range, { includeComplete: strict })) {
      if (box.provider !== 'coupang' || !box.source_json) continue;
      const archived = JSON.parse(box.source_json);
      if (!archived?.location) continue;
      const source = fromWorkbook.get(sourceKey(archived.location, box.product_order_id));
      const recipient = recipientKey(box.recipient);
      if (!recipient || !source || recipientKey(source.shippingAddress.name) !== recipient
        || recipientKey(shippingAddressFromSource(archived)?.name) !== recipient) continue;
      matches.push({ boxId: box.id, value: value(source), storedValue: box[column] });
    }
    const missing = matches.filter(match => match.storedValue == null || match.storedValue === '');
    if (strict) {
      if (matches.length !== expectedBoxes) throw new Error('원본으로 확인한 출고 상자 수가 예상과 다릅니다.');
      if (matches.some(match => !match.value || (match.storedValue && match.storedValue !== match.value))) {
        throw new Error(`출고 상자 ${label}가 원본과 일치하지 않습니다.`);
      }
      if (missing.length && (verifyOnly || missing.length !== expectedBoxes)) {
        throw new Error(`출고 상자 ${label}의 복원 상태가 예상과 다릅니다.`);
      }
    }
    let restoredBoxes = 0;
    if (!verifyOnly && missing.length) {
      const update = db.prepare(`UPDATE order_dispatch_boxes SET ${column} = ? WHERE id = ? AND NULLIF(${column}, '') IS NULL`);
      for (const match of missing) if (match.value) restoredBoxes += update.run(match.value, match.boxId).changes;
      if (strict) {
        if (restoredBoxes !== missing.length) throw new Error('실제로 복원한 출고 상자 수가 예상과 다릅니다.');
        const persisted = db.prepare(`SELECT ${column} AS value FROM order_dispatch_boxes WHERE id = ?`);
        if (matches.some(match => persisted.get(match.boxId)?.value !== match.value)) {
          throw new Error(`복원한 ${label}가 원본과 일치하지 않습니다.`);
        }
      }
    }
    return { matchedBoxes: matches.length, restoredBoxes };
  }
  return verifyOnly ? recover() : transaction(db, recover);
}

export function recoverCoupangDispatchPhones(db, file, date, options = {}) {
  return recoverDispatchField(db, file, date, options, 'contact_phone', source => source.shippingAddress.tel1, '연락처');
}

export function recoverCoupangDispatchMemos(db, file, date, expectedBoxes, { verifyOnly = false } = {}) {
  if (expectedBoxes === undefined) throw new Error('복원할 출고 상자 수를 확인해 주세요.');
  return recoverDispatchField(db, file, date, { expectedBoxes, verifyOnly }, 'shipping_memo', source => source.shippingMemo, '배송메모');
}
