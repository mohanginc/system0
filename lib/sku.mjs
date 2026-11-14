import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../data/sku-catalog.json', import.meta.url), 'utf8'));
export const skuCatalog = Object.freeze(catalog.entries.map(entry => Object.freeze({ ...entry, aliases: Object.freeze(entry.aliases) })));
const markers = new Set(['coupang', '쿠팡', '베라쇼', '인스타그램이벤트', '맞교환', '주소변경']);

function nameParts(value) {
  let key = typeof value === 'string' ? value.normalize('NFC').replace(/\s/g, '').toLowerCase() : '';
  let exchange = false;
  while (key.startsWith('[')) {
    const end = key.indexOf(']'), marker = key.slice(1, end);
    if (end < 0 || !markers.has(marker)) break;
    if (marker === '맞교환') exchange = true;
    key = key.slice(end + 1);
  }
  return { key, exchange };
}

const aliases = new Map(), barcodes = new Set();
export function validBarcode(barcode) {
  if (typeof barcode !== 'string' || !/^\d{13}$/.test(barcode)) return false;
  const sum = [...barcode.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return Number(barcode[12]) === (10 - sum % 10) % 10;
}
export const skuNameKey = name => nameParts(name).key;

for (const entry of skuCatalog) {
  if (!validBarcode(entry.barcode) || barcodes.has(entry.barcode)) throw new Error('SKU 마스터의 바코드 형식·체크숫자·중복을 확인해 주세요.');
  barcodes.add(entry.barcode);
  if (!entry.enabled) continue;
  for (const alias of entry.aliases) {
    const { key } = nameParts(alias), existing = aliases.get(key);
    if (!key || existing && existing !== entry.barcode) throw new Error('SKU 별칭이 비어 있거나 서로 다른 바코드와 중복됩니다.');
    aliases.set(key, entry.barcode);
  }
}

export function initializeSkuCatalog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sku_products (
    barcode TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS sku_aliases (
    name_key TEXT PRIMARY KEY, name TEXT NOT NULL, barcode TEXT NOT NULL REFERENCES sku_products(barcode),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS sku_aliases_barcode ON sku_aliases(barcode);`);
  const addProduct = db.prepare('INSERT OR IGNORE INTO sku_products(barcode,name,enabled) VALUES(?,?,?)');
  const addAlias = db.prepare('INSERT OR IGNORE INTO sku_aliases(name_key,name,barcode) VALUES(?,?,?)');
  for (const entry of skuCatalog) {
    const name = [entry.product.trim(), entry.design.trim(), entry.option.trim(), entry.condition].filter(Boolean).join(' · ');
    addProduct.run(entry.barcode, name, Number(entry.enabled));
    if (entry.enabled) for (const alias of entry.aliases) addAlias.run(skuNameKey(alias), alias, entry.barcode);
  }
}

export function barcodeForName(name, db) {
  const key = skuNameKey(name);
  if (db) return db.prepare(`SELECT a.barcode FROM sku_aliases a JOIN sku_products p ON p.barcode=a.barcode
    WHERE a.name_key=? AND p.enabled=1`).get(key)?.barcode || null;
  return aliases.get(key) || null;
}

export function shipmentType(name, originalName = '') {
  return nameParts(name).exchange || nameParts(originalName).exchange ? 'exchange' : 'sale';
}
