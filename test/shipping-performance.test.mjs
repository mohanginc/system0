import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { shippingBoard, shippingDates } from '../lib/shipping.mjs';
import { importInvoiceFiles, refreshInvoiceStatus, refreshOutsideInvoiceStatus, shipmentInvoiceStates, shipmentInvoiceStatesByGroups } from '../lib/invoices.mjs';
import { createWeekendScenario, sourceFile, naverFile, courierFile, registeredOrder } from './fixtures/weekend-invoices.mjs';

test('월 달력은 송장 이력을 한 번 읽고 날짜별 완료·대기 상태와 재조회 변경을 보존한다', async () => {
  const db = openDatabase(':memory:');
  try {
    const scenario = createWeekendScenario();
    const orders = [scenario.days[1].orders[0], scenario.days[2].orders[0]];
    const outside = { ...scenario.days[1].orders[1], manual: true };
    for (const [date, rows] of [['2026-11-01', [orders[0], outside]], ['2026-11-02', [orders[1]]]]) {
      const file = sourceFile(rows), detail = importFiles(db, [{ originalname: file.name, buffer: file.buffer }]);
      db.prepare('UPDATE batches SET created_at = ? WHERE id = ?').run(date + 'T00:00:00.000Z', detail.batch.id);
      db.prepare("UPDATE rows SET cleaned_name = original_name, status = 'confirmed' WHERE batch_id = ?").run(detail.batch.id);
    }
    const run = importInvoiceFiles(db, { naverFiles: [naverFile(orders)], courierFiles: [courierFile(orders)],
      carrier: { code: 'KGB', name: '로젠택배' }, sourceDate: '2026-11-02' });
    const allOrders = [...orders, outside];
    let pending = false;
    const naver = { getProductOrderIds: async orderId => allOrders.filter(order => order.orderId === orderId).map(order => order.productOrderId),
      queryProductOrders: async ids => ids.map(id => registeredOrder(allOrders.find(order => order.productOrderId === id),
        pending && id === orders[1].productOrderId ? { status: 'PAYED', trackingNumber: '', deliveryCompanyCode: '', deliveryStatus: '' } : {})) };
    await refreshInvoiceStatus(db, run.run.id, naver);
    await refreshOutsideInvoiceStatus(db, run.run.id, naver);
    const expected = () => ['2026-11-01', '2026-11-02'].map(date => ({ date, batchCount: 1, invoiceState: shippingBoard(db, date).invoiceState }));
    const before = expected();
    assert.deepEqual(before.map(day => day.invoiceState), ['complete', 'complete']);
    let scans = 0;
    const counted = { prepare(sql) {
      if (/SELECT i\.\*, r\.mall, r\.store FROM invoice_items/.test(sql)) scans++;
      return db.prepare(sql);
    } };
    assert.deepEqual(shippingDates(counted, '2026-11').days, before);
    assert.equal(scans, 1, '날짜마다 전체 송장 이력을 다시 조회하지 않습니다.');
    pending = true;
    await refreshInvoiceStatus(db, run.run.id, naver);
    const after = expected();
    assert.deepEqual(after.map(day => day.invoiceState), ['complete', 'pending']);
    scans = 0;
    assert.deepEqual(shippingDates(counted, '2026-11').days, after, '이전 요청의 상태를 캐시하지 않습니다.');
    assert.equal(scans, 1);
    const groups = [[outside.internalId], [orders[0].internalId, orders[1].internalId], []];
    const individual = groups.map(ids => shipmentInvoiceStates(db, ids));
    assert.deepEqual(shipmentInvoiceStatesByGroups(db, groups), individual);
    assert.deepEqual(shipmentInvoiceStatesByGroups(db, [...groups].reverse()), [...individual].reverse(), '날짜 순서가 바뀌어도 파일 밖 주문의 확인 범위는 섞이지 않습니다.');
    assert.deepEqual(shippingDates(counted, '2026-12').days, []);
    assert.deepEqual(shipmentInvoiceStatesByGroups(null, []), []);
    assert.deepEqual(shipmentInvoiceStatesByGroups(null, [[], []]), [{}, {}]);
  } finally { db.close(); }
});
