import * as XLSX from 'xlsx';

export const sourceDate = '2026-11-02';
export const sourceHeaders = ['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량', '쇼핑몰'];
const naverHeaders = ['상품주문번호', '주문번호', '상품명', '옵션정보', '수량', '수취인명', '수취인연락처1', '통합배송지', '주문상태', '주문세부상태', '택배사', '송장번호'];
const courierHeaders = ['운송장번호', '주문번호', '차수', '원송장번호', '발행횟수', '출력시간', '물품명', '이름', '전화', '주소'];

export function workbookFile(name, headers, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...rows]), '주문');
  return { name, buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) };
}

export function sourceFile(orders, name = '가상_확인주문.xlsx') {
  return workbookFile(name, sourceHeaders, orders.map(order => [order.productName, order.internalId, order.orderId,
    order.recipient, order.phone, order.address, order.quantity, '네이버']));
}

export function naverFile(orders, name = '가상_월요일_최종네이버.xlsx') {
  return workbookFile(name, naverHeaders, orders.map(order => [order.productOrderId, order.orderId, order.productName,
    order.optionName, order.quantity, order.recipient, order.phone, order.address, order.status || '발송대기', '', order.carrier || '', order.sourceTrackingNumber || '']));
}

export function courierFile(orders, name = '가상_월요일_로젠송장.xlsx') {
  return workbookFile(name, courierHeaders, orders.map(order => [order.trackingNumber, order.internalId, order.round || 1,
    order.originalTrackingNumber || '', order.issueCount || 1, order.printedAt || '2026-11-02T17:00:00+09:00',
    order.productName, order.recipient, order.phone, order.address]));
}

function orderFor(date, label, index) {
  const number = index + 1, day = date.replaceAll('-', '');
  return { date, productOrderId: day + String(number).padStart(8, '0'), orderId: day + String(10000 + number).padStart(8, '0'),
    internalId: `WEEKEND-${day}-${String(number).padStart(3, '0')}`, trackingNumber: '99' + day.slice(4) + String(number).padStart(6, '0'),
    recipient: `가상 ${label} 수취인 ${String(number).padStart(2, '0')}`, phone: `010-0000-${String(number).padStart(4, '0')}`,
    address: `서울 테스트구 테스트로 ${number} 101호`, productName: `가상 쿠션 ${number % 3 + 1}`, optionName: '선택 옵션: 테스트 커버', quantity: 1 };
}

export function createWeekendScenario({ sundayManual = 0, orphanCount = 0, missingCourierIds = [] } = {}) {
  const days = [['2026-10-31', '토요일', 20, 10], ['2026-11-01', '일요일', 40, sundayManual], ['2026-11-02', '월요일', 40, 0]]
    .map(([date, label, total, manualCount]) => {
      const orders = Array.from({ length: total }, (_, index) => ({ ...orderFor(date, label, index), manual: index < manualCount }));
      return { date, label, orders, file: sourceFile(orders, `가상_${date}_${label}_확인주문.xlsx`) };
    });
  const allOrders = days.flatMap(day => day.orders), manualOrders = allOrders.filter(order => order.manual);
  const storedPendingOrders = allOrders.filter(order => !order.manual);
  const orphanOrders = Array.from({ length: orphanCount }, (_, index) => ({ ...orderFor(sourceDate, '원본없음', index + 1000),
    recipient: storedPendingOrders[0].recipient, phone: storedPendingOrders[0].phone, address: storedPendingOrders[0].address }));
  const pendingOrders = [...storedPendingOrders, ...orphanOrders];
  const courierOrders = storedPendingOrders.filter(order => !missingCourierIds.includes(order.internalId));
  return { sourceDate, days, allOrders, pendingOrders, storedPendingOrders, manualOrders, orphanOrders,
    naverFile: naverFile(pendingOrders), courierFile: courierFile(courierOrders) };
}

export function registeredOrder(order, changes = {}) {
  return { productOrderId: order.productOrderId, orderId: order.orderId, status: 'DELIVERING', placeOrderStatus: 'OK',
    remainQuantity: order.quantity, recipient: order.recipient, phone: order.phone,
    address: order.address.slice(0, -5).trim(), detailAddress: '101호', trackingNumber: order.trackingNumber,
    deliveryCompanyCode: 'KGB', claimStatus: '', deliveryStatus: 'DELIVERING', deliveryMethod: 'DELIVERY',
    isWrongTrackingNumber: false, ...changes };
}
