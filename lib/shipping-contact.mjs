const text = value => value == null ? '' : String(value).normalize('NFC').trim();
const shippingFields = { recipient: 100, phone: 40, baseAddress: 300, detailedAddress: 300, postalCode: 12, memo: 500 };

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

export function shippingAddressFromSource(source) {
  return source?.content?.productOrder?.shippingAddress ?? source?.productOrder?.shippingAddress ?? source?.shippingAddress;
}

export function shippingContact(address) {
  return { phone: text(address?.tel1) || text(address?.tel2), neighborhood: neighborhood(address?.baseAddress) };
}

export function shippingDetailsFromSource(source) {
  const product = source?.content?.productOrder ?? source?.productOrder ?? source?.columns;
  return { ...shippingAddressFromSource(source), memo: text(source?.shippingMemo) || text(product?.shippingMemo) };
}

export function editableShipping(address) {
  return { recipient: text(address?.name), phone: shippingContact(address).phone, baseAddress: text(address?.baseAddress),
    detailedAddress: text(address?.detailedAddress), postalCode: text(address?.zipCode), memo: text(address?.memo) };
}

export function shippingEditPatch(shipping) {
  if (shipping && typeof shipping === 'object' && !Array.isArray(shipping)) {
    const entries = Object.entries(shipping);
    if (entries.every(([key, value]) => Object.hasOwn(shippingFields, key) && typeof value === 'string'
      && value.trim().length <= shippingFields[key] && (!['recipient', 'phone', 'baseAddress'].includes(key) || value.trim()))) {
      return Object.fromEntries(entries.map(([key, value]) => [key, value.trim()]));
    }
  }
  throw Object.assign(new Error('수정할 배송 정보를 확인해 주세요.'), { status: 400 });
}

export function dispatchContactSnapshots(db, from, to, { includeComplete = false } = {}) {
  return db.prepare(`SELECT b.id, b.recipient, b.contact_phone, b.contact_neighborhood, b.shipping_memo,
      i.provider, i.product_order_id, s.source_json
    FROM order_dispatch_boxes b
    JOIN order_dispatch_items i ON i.dispatch_box_id = b.id AND i.order_item_id = (
      SELECT min(first.order_item_id) FROM order_dispatch_items first WHERE first.dispatch_box_id = b.id
    )
    LEFT JOIN order_intake_snapshots s ON s.id = (
      SELECT snapshot.id FROM order_intake_snapshots snapshot WHERE snapshot.item_id = i.order_item_id
        AND snapshot.recorded_at <= b.registered_at ORDER BY snapshot.recorded_at DESC, snapshot.id DESC LIMIT 1
    )
    WHERE b.registered_at >= ? AND b.registered_at < ?
      AND (? OR NULLIF(b.contact_phone, '') IS NULL OR b.contact_neighborhood IS NULL) ORDER BY b.id`).all(from, to, Number(includeComplete));
}
