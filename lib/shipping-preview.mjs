import { normalizePreviewNames } from './naming.mjs';
import { neighborhood, mostFrequentName } from './shipping.mjs';
import { barcodeForName, shipmentType as skuShipmentType } from './sku.mjs';

export async function previewShippingBoard(db, naver, client, model) {
  const { from, to, orders } = await naver.listNewOrders();
  const names = await normalizePreviewNames(db, orders.map((order, index) => ({ id: index + 1,
    originalName: order.originalName, productName: order.productName, optionName: order.optionName })), client, model);
  const groups = new Map(), groupNames = new Map();
  let quantity = 0, attentionQuantity = 0;
  for (let index = 0; index < orders.length; index++) {
    const order = orders[index], name = names[index];
    const skuBarcode = name.skuBarcode || barcodeForName(name.cleanedName, db), shipmentType = skuShipmentType(name.cleanedName, order.originalName);
    const key = JSON.stringify(skuBarcode ? ['sku', skuBarcode, shipmentType] : ['name', name.cleanedName, name.needsAttention, shipmentType]);
    if (!groups.has(key)) groups.set(key, { key, name: name.cleanedName, needsAttention: name.needsAttention,
      skuBarcode, shipmentType, count: 0, invoiceState: 'unavailable', shipments: [] });
    const group = groups.get(key);
    group.needsAttention ||= name.needsAttention;
    if (!groupNames.has(key)) groupNames.set(key, new Map());
    const namesForGroup = groupNames.get(key);
    if (!namesForGroup.has(name.cleanedName)) namesForGroup.set(name.cleanedName, new Set());
    namesForGroup.get(name.cleanedName).add(order.productOrderId);
    group.count += order.quantity; quantity += order.quantity;
    if (name.needsAttention) attentionQuantity += order.quantity;
    group.shipments.push({ id: order.productOrderId, productOrderId: order.productOrderId, orderId: order.orderId,
      quantity: order.quantity, recipient: order.recipient, phone: order.phone, neighborhood: neighborhood(order.address), channels: ['네이버'],
      note: name.needsAttention ? name.note : '' });
  }
  for (const group of groups.values()) group.name = mostFrequentName(new Map([...groupNames.get(group.key)]
    .map(([name, productIds]) => [name, productIds.size])));
  return { mode: 'new', from, to, updatedAt: new Date().toISOString(), invoiceState: 'unavailable',
    summary: { orderCount: new Set(orders.map(order => order.orderId)).size, rowCount: orders.length, quantity,
      groupCount: groups.size, attentionQuantity },
    groups: [...groups.values()].sort((a, b) => Number(a.needsAttention) - Number(b.needsAttention)
      || b.count - a.count || a.name.localeCompare(b.name, 'ko')) };
}
