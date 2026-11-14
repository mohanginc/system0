import { transaction } from './database.mjs';
import { skuNameKey, validBarcode } from './sku.mjs';

function nameValue(value, limit = 500) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit || value.includes('\0')) {
    throw new Error(`제품명을 1~${limit}자로 입력해 주세요.`);
  }
  return value.trim();
}

function activeRows(db) {
  return db.prepare(`SELECT r.id,r.cleaned_name,r.sku_barcode FROM rows r JOIN batches b ON b.id=r.batch_id
    WHERE r.is_deleted=0 AND b.is_deleted=0 AND r.cleaned_name<>'' ORDER BY r.id`).all();
}

export function productCatalog(db) {
  const products = db.prepare(`SELECT p.barcode,p.name,count(a.name_key) AS aliasCount FROM sku_products p
    LEFT JOIN sku_aliases a ON a.barcode=p.barcode WHERE p.enabled=1 GROUP BY p.barcode ORDER BY p.name,p.barcode`).all();
  const unmatched = new Map();
  for (const row of activeRows(db)) {
    const key = skuNameKey(row.cleaned_name);
    if (row.sku_barcode || !key) continue;
    if (!unmatched.has(key)) unmatched.set(key, { name: row.cleaned_name, rowCount: 0 });
    unmatched.get(key).rowCount++;
  }
  return { products, unmatched: [...unmatched.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko')) };
}

export function addProduct(db, input = {}) {
  const { barcode } = input, name = nameValue(input.name, 200);
  if (!validBarcode(barcode)) throw new Error('13자리 바코드와 마지막 체크숫자를 확인해 주세요.');
  return transaction(db, () => {
    if (db.prepare('SELECT barcode FROM sku_products WHERE barcode=?').get(barcode)) throw new Error('이미 등록된 바코드입니다.');
    db.prepare('INSERT INTO sku_products(barcode,name) VALUES(?,?)').run(barcode, name);
    return { product: { barcode, name, aliasCount: 0 } };
  });
}

export function linkProductName(db, input = {}) {
  const name = nameValue(input.name), key = skuNameKey(name), { barcode } = input;
  if (!key || !validBarcode(barcode)) throw new Error('연결할 제품명과 바코드를 확인해 주세요.');
  return transaction(db, () => {
    if (!db.prepare('SELECT barcode FROM sku_products WHERE barcode=? AND enabled=1').get(barcode)) throw new Error('연결할 상품을 찾을 수 없습니다.');
    const existing = db.prepare('SELECT barcode FROM sku_aliases WHERE name_key=?').get(key);
    if (existing && existing.barcode !== barcode) throw new Error('이미 다른 바코드에 연결된 제품명입니다. 목록을 새로고침해 주세요.');
    const rows = activeRows(db).filter(row => skuNameKey(row.cleaned_name) === key);
    if (!rows.length) throw new Error('연결할 저장 상품명이 없습니다. 목록을 새로고침해 주세요.');
    if (rows.some(row => row.sku_barcode && row.sku_barcode !== barcode)) throw new Error('이미 다른 바코드가 저장된 주문이 있습니다.');
    if (!existing) db.prepare('INSERT INTO sku_aliases(name_key,name,barcode) VALUES(?,?,?)').run(key, name, barcode);
    const update = db.prepare('UPDATE rows SET sku_barcode=? WHERE id=?');
    let linkedRows = 0;
    for (const row of rows) if (row.sku_barcode !== barcode) linkedRows += update.run(barcode, row.id).changes;
    return { name, barcode, linkedRows };
  });
}
