import { transaction } from './database.mjs';
import { refreshIntakeSkus } from './order-intake.mjs';
import { skuNameKey, validBarcode } from './sku.mjs';

const seoulDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});
const costFields = 'effective_date AS effectiveDate,unit_cost_krw AS unitCostKrw,created_at AS createdAt';

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

function collectedRows(db) {
  return db.prepare(`SELECT id,cleaned_name,sku_barcode FROM order_intake_items
    WHERE state<>'closed' AND cleaned_name<>'' ORDER BY id`).all();
}

export function productCatalog(db) {
  const products = db.prepare(`SELECT p.barcode,p.name,count(a.name_key) AS aliasCount,
    c.unit_cost_krw AS unitCostKrw,c.effective_date AS costEffectiveDate FROM sku_products p
    LEFT JOIN sku_aliases a ON a.barcode=p.barcode
    LEFT JOIN sku_costs c ON c.barcode=p.barcode AND c.effective_date=(
      SELECT max(effective_date) FROM sku_costs WHERE barcode=p.barcode AND effective_date<=?
    )
    WHERE p.enabled=1 GROUP BY p.barcode ORDER BY p.name,p.barcode`).all(seoulDate.format(new Date()));
  const unmatched = new Map();
  for (const row of [...activeRows(db), ...collectedRows(db)]) {
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
    return { product: { barcode, name, aliasCount: 0, unitCostKrw: null, costEffectiveDate: null } };
  });
}

function costProduct(db, barcode) {
  if (!validBarcode(barcode)) throw new Error('13자리 바코드를 확인해 주세요.');
  const product = db.prepare('SELECT barcode,name FROM sku_products WHERE barcode=? AND enabled=1').get(barcode);
  if (!product) throw new Error('등록된 상품을 찾을 수 없습니다.');
  return product;
}

export function productCostHistory(db, barcode) {
  const product = costProduct(db, barcode);
  const costs = db.prepare(`SELECT ${costFields} FROM sku_costs WHERE barcode=? ORDER BY effective_date DESC`).all(barcode);
  return { product, costs, today: seoulDate.format(new Date()) };
}

export function addProductCost(db, barcode, { effectiveDate, unitCostKrw } = {}) {
  const start = typeof effectiveDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) && !effectiveDate.startsWith('0000')
    ? new Date(effectiveDate + 'T00:00:00Z') : new Date(NaN);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== effectiveDate) {
    throw new Error('실제 적용 시작일을 입력해 주세요.');
  }
  if (!Number.isSafeInteger(unitCostKrw) || unitCostKrw < 0) {
    throw new Error('단위 원가는 0 이상의 정수(원)로 입력해 주세요.');
  }
  return transaction(db, () => {
    costProduct(db, barcode);
    const previous = db.prepare(`SELECT ${costFields} FROM sku_costs WHERE barcode=? AND effective_date=?`).get(barcode, effectiveDate);
    if (previous) {
      if (previous.unitCostKrw !== unitCostKrw) throw new Error('해당 적용일에 등록된 원가가 있습니다. 다른 적용일을 입력해 주세요.');
      return { cost: { ...previous } };
    }
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO sku_costs (barcode,effective_date,unit_cost_krw,created_at) VALUES (?,?,?,?)')
      .run(barcode, effectiveDate, unitCostKrw, createdAt);
    refreshIntakeSkus(db);
    return { cost: { effectiveDate, unitCostKrw, createdAt } };
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
    const intake = collectedRows(db).filter(row => skuNameKey(row.cleaned_name) === key);
    if (!rows.length && !intake.length) throw new Error('연결할 저장 상품명이 없습니다. 목록을 새로고침해 주세요.');
    if ([...rows, ...intake].some(row => row.sku_barcode && row.sku_barcode !== barcode)) {
      throw new Error('이미 다른 바코드가 저장된 주문이 있습니다.');
    }
    if (!existing) db.prepare('INSERT INTO sku_aliases(name_key,name,barcode) VALUES(?,?,?)').run(key, name, barcode);
    const update = db.prepare('UPDATE rows SET sku_barcode=? WHERE id=?');
    let linkedRows = 0;
    for (const row of rows) if (row.sku_barcode !== barcode) linkedRows += update.run(barcode, row.id).changes;
    if (intake.length) {
      refreshIntakeSkus(db);
      const findLinked = db.prepare('SELECT 1 FROM order_intake_items WHERE id=? AND sku_barcode=?');
      linkedRows += intake.filter(row => !row.sku_barcode && findLinked.get(row.id, barcode)).length;
    }
    return { name, barcode, linkedRows };
  });
}
