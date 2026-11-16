import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { createDiscordHandler } from '../lib/discord-bot.mjs';

process.env.SYSTEM0_ENV_FILE = path.join(os.tmpdir(), `absent-${randomUUID()}.env`);
process.env.DISCORD_ENV_FILE = path.join(os.tmpdir(), `absent-${randomUUID()}.env`);
const { createApp } = await import('../server.mjs');
const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const first = '45500000001', second = '45500000002', date = '2026-11-13';
const orderId = '202611130000000099', productIds = ['202611130000000001', '202611130000000002'];
const customer = ['가상 수취인', '010-0000-0000', '서울 검증로 1'];
const config = { secret: 'tracking-end-to-end-isolated-secret', guildId: scope.guildId, channelIds: [scope.channelId],
  userIds: [scope.userId], publicOrigin: 'https://system0.example' };
function workbook(rows) {
  const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, XLSX.utils.aoa_to_sheet(rows), '주문');
  return XLSX.write(b, { type: 'buffer', bookType: 'xlsx' });
}
const naver = workbook([['상품주문번호', '주문번호', '상품명', '수량', '수취인명', '수취인연락처1', '통합배송지', '주문상태'],
  ...productIds.map(id => [id, orderId, '가상 쿠션', 1, ...customer, '발송대기'])]);
const courier = numbers => workbook([['주문번호', '운송장번호', '차수', '발행횟수', '출력시간', '물품명', '이름', '전화', '주소'],
  ...numbers.map(number => ['000001', number, number === first ? 1 : 2, 1,
    number === first ? '10:11:28' : '10:28:07', '가상 쿠션', ...customer])]);
const components = output => (output.components || []).flatMap(row => row.components || []);
const rows = bytes => { const b = XLSX.read(bytes, { type: 'buffer' }); return XLSX.utils.sheet_to_json(b.Sheets['발송처리'], { header: 1 }); };

test('채팅 첨부→직원 분할선택→실제 엑셀→정정파일 일괄교체가 공통 HTTP API와 웹 상태에 이어진다', async t => {
  let outsideCalls = 0;
  const app = createApp({ databasePath: ':memory:', apiKey: '', client: null, discordConfig: config,
    naver: { queryProductOrders: async () => { outsideCalls++; throw Error('No live Naver'); } } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); app.locals.db.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const source = workbook([['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량', '쇼핑몰'],
    ['가상 쿠션', '000001', orderId, ...customer, 1, '네이버']]);
  const form = new FormData(); form.append('files', new Blob([source]), '가상원본.xlsx');
  assert.equal((await fetch(baseUrl + '/api/import', { method: 'POST', body: form })).status, 201);
  let courierBytes = courier([first, second]);
  const handle = createDiscordHandler({ config: { ...config, baseUrl }, fetcher: (url, options) =>
    String(url).startsWith(baseUrl) ? fetch(url, options) : Promise.resolve(new Response(String(url).includes('naver') ? naver : courierBytes)) });
  let sequence = 555555555555555555n;
  const event = extra => ({ ...scope, id: String(sequence++), ...extra });
  const attachments = [
    { name: 'naver.xlsx', url: 'https://cdn.discordapp.com/attachments/1/2/naver.xlsx', size: naver.length },
    { name: 'courier.xlsx', url: 'https://cdn.discordapp.com/attachments/1/2/courier.xlsx', size: courierBytes.length },
  ];
  const initial = await handle(event({ action: 'create_invoice', date, attachments }));
  assert.equal(initial.files, undefined, initial.content);
  const menu = components(initial).find(c => c.type === 3); assert.ok(menu, initial.content);
  assert.ok(!components(initial).some(c => /엑셀/.test(c.label || '')));
  assert.equal(app.locals.db.prepare('SELECT count(*) n FROM invoice_runs WHERE generated_at IS NOT NULL').get().n, 0);
  const selected = await handle(event({ buttonId: menu.custom_id, values: [`split:${second}`] }));
  assert.equal(selected.files, undefined);
  const build = components(selected).find(c => c.label === '선택 완료 · 엑셀 만들기'); assert.ok(build, selected.content);
  const generated = await handle(event({ buttonId: build.custom_id })); assert.ok(generated.files, generated.content);
  const originalBytes = generated.files[0].attachment;
  assert.deepEqual(rows(originalBytes).slice(1).map(row => [row[0], row[3]]), productIds.map(id => [id, second]));
  const before = await (await fetch(baseUrl + '/api/invoices/1')).json();
  assert.equal(before.fileActions.saved, true);
  assert.equal(before.fileActions.reviewRequired, false);
  assert.ok(before.items.every(item => item.trackingNumber === second && item.physicalShipments.filter(s => s.valid === true).length === 2));
  courierBytes = courier([second]);
  const correction = await handle(event({ action: 'replace_invoice', date, attachments }));
  assert.equal(correction.files, undefined);
  const confirm = components(correction).find(c => c.label === '이번 파일의 송장으로 교체'); assert.ok(confirm, correction.content);
  const corrected = await handle(event({ buttonId: confirm.custom_id })); assert.ok(corrected.files, corrected.content);
  assert.deepEqual(rows(corrected.files[0].attachment).slice(1).map(row => row[3]), [second, second]);
  const after = await (await fetch(baseUrl + '/api/invoices/2')).json();
  assert.equal(after.trackingReview.pendingCount, 0);
  assert.ok(after.items.every(item => item.trackingNumber === second && item.physicalShipments.find(s => s.trackingNumber === first).valid === false));
  assert.equal(after.issues.some(i => i.kind === 'courier_conflict'), false);
  assert.equal((await fetch(baseUrl + '/api/invoices/1/download')).status, 200);
  assert.ok(Buffer.from(await (await fetch(baseUrl + '/api/invoices/1/download')).arrayBuffer()).equals(originalBytes));
  const stale = await fetch(baseUrl + '/api/invoices/2/tracking', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: before.viewVersion, choices: [{ key: after.trackingReview.groups[0].key, mode: 'replace', trackingNumber: second }] }) });
  assert.equal(stale.status, 409);
  assert.equal(outsideCalls, 0);
});
