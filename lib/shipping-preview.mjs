import { normalizePreviewNames } from './naming.mjs';
import { neighborhood } from './shipping.mjs';

export async function previewShippingBoard(db, naver, client, model) {
  const { from, to, orders } = await naver.listNewOrders();
  const names = await normalizePreviewNames(db, orders.map((order, index) => ({ id: index + 1,
    originalName: order.originalName, productName: order.productName, optionName: order.optionName })), client, model);
  const groups = new Map();
  let quantity = 0, attentionQuantity = 0;
  for (let index = 0; index < orders.length; index++) {
    const order = orders[index], name = names[index];
    const key = JSON.stringify([name.cleanedName, name.needsAttention]);
    if (!groups.has(key)) groups.set(key, { key, name: name.cleanedName, needsAttention: name.needsAttention,
      count: 0, invoiceState: 'unavailable', shipments: [] });
    const group = groups.get(key);
    group.count += order.quantity; quantity += order.quantity;
    if (name.needsAttention) attentionQuantity += order.quantity;
    group.shipments.push({ id: order.productOrderId, productOrderId: order.productOrderId, orderId: order.orderId,
      quantity: order.quantity, recipient: order.recipient, phone: order.phone, neighborhood: neighborhood(order.address),
      note: name.needsAttention ? name.note : '' });
  }
  return { mode: 'new', from, to, updatedAt: new Date().toISOString(), invoiceState: 'unavailable',
    summary: { orderCount: new Set(orders.map(order => order.orderId)).size, rowCount: orders.length, quantity,
      groupCount: groups.size, attentionQuantity },
    groups: [...groups.values()].sort((a, b) => Number(a.needsAttention) - Number(b.needsAttention)
      || b.count - a.count || a.name.localeCompare(b.name, 'ko')) };
}
