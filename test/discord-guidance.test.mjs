import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { openDatabase } from '../lib/database.mjs';
import { importFiles } from '../lib/excel.mjs';
import { CARRIERS, importInvoiceFiles } from '../lib/invoices.mjs';
import { initializeDiscordWorkflow, interpretDiscordRequest, claimDiscordRequest, finishDiscordRequest, discordContext } from '../lib/discord-workflow.mjs';

const date = '2026-11-14';
const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const request = { ...scope, text: '재출력 번호만 올렸으니 기존 송장을 교체해줘', date, hasAttachments: true };
function setup(t) {
  const db = openDatabase(':memory:'); initializeDiscordWorkflow(db); t.after(() => db.close()); return db;
}
function model(answer, inspect = () => {}) {
  return { responses: { create: async value => { inspect(value); return { output_text: JSON.stringify(answer) }; } } };
}
function file(rows, name) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '주문');
  return { originalname: name, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) };
}
function invoice(db) {
  const recipient = '모델에 보내지 않을 수취인', phone = '010-1111-2222', address = '모델에 보내지 않을 전체 주소';
  const order = '202611140000000099', product = '202611140000000001';
  importFiles(db, [file([['원상품명', '주문번호', '체결번호', '송화주', '전화번호', '주소', '수량'],
    ['비공개 원상품명', '000001', order, recipient, phone, address, 1]], '저장 원본.xlsx')]);
  const detail = importInvoiceFiles(db, {
    sourceDate: date, carrier: CARRIERS[0],
    naverFiles: [file([['상품주문번호', '주문번호', '상품명', '수량', '수취인명', '수취인연락처1', '통합배송지', '주문상태'],
      [product, order, '비공개 원상품명', 1, recipient, phone, address, 'PAYED']], '네이버.xlsx')],
    courierFiles: [file([['운송장번호', '주문번호'], ['45500000001', '000001']], '로젠.xlsx')],
  });
  return { detail, privateValues: [recipient, phone, address, order, product, '비공개 원상품명', '저장 원본.xlsx'] };
}

test('교체 요청은 실제 업무 지침을 읽고 지원 action과 진행 전 설명을 반환한다', async t => {
  const db = setup(t); let sent;
  const answer = { action: 'replace_invoice', date: null, message: '정정 파일을 비교하고 교체 범위를 확인하겠습니다.' };
  assert.deepEqual(await interpretDiscordRequest(db, request, model(answer, value => { sent = value; }), 'mock-model'), answer);
  const guide = readFileSync(new URL('../prompts/discord-workflows.md', import.meta.url), 'utf8');
  assert.ok(sent.instructions.includes(guide.trim()));
  for (const term of ['분할', '대표', '보관', 'SKU', '등록 상태', '교체']) assert.ok(guide.includes(term), term);
  assert.match(guide, /같은 내부 출고를 재출력한 경우.*선택은 연동/);
  assert.match(guide, /내부 출고가 다른 분리 배송은 상품주문번호·옵션별로 송장을 독립 선택/);
  assert.equal(sent.store, false);
  const schema = sent.text.format.schema;
  assert.ok(schema.properties.action.enum.includes('replace_invoice'));
  assert.ok(schema.properties.action.enum.includes('rebuild_file'));
  assert.ok(!schema.properties.action.enum.includes('replace_tracking'), '실제 교체 확인을 LLM 의도만으로 실행하지 않는다.');
  assert.equal(db.prepare('SELECT count(*) n FROM discord_requests').get().n, 0);
});

test('현재 작업은 상태와 가능한 다음 조작만 모델에 전달하고 고객과 파일 원문은 보내지 않는다', async t => {
  const db = setup(t), { detail, privateValues } = invoice(db); let sent;
  const before = db.prepare('SELECT * FROM invoice_items').all();
  await interpretDiscordRequest(db, { ...request, text: '왜 엑셀을 못 받지?', hasAttachments: false, runId: detail.run.id },
    model({ action: 'help', date: null, message: '현재 작업의 검토 상태를 확인해 주세요.' }, value => { sent = value; }), 'mock-model');
  const input = JSON.parse(sent.input);
  assert.equal(input.workflow.runId, detail.run.id);
  assert.equal(input.workflow.total, 1);
  assert.equal(input.workflow.savedFileAvailable, false);
  assert.ok(Array.isArray(input.workflow.allowedNextActions));
  for (const value of [...privateValues, ...Object.values(scope)]) assert.ok(!sent.input.includes(value), value);
  assert.deepEqual(db.prepare('SELECT * FROM invoice_items').all(), before);
});

test('선택과 새 파일 요청도 기존 요청 이력에 남고 채널의 이어갈 작업을 갱신한다', t => {
  const db = setup(t), { detail } = invoice(db);
  for (const [index, action] of ['replace_invoice', 'review_tracking', 'select_tracking', 'replace_tracking', 'rebuild_file'].entries()) {
    const requestId = String(555555555555555550n + BigInt(index));
    const body = { ...scope, requestId, action, date, runId: detail.run.id };
    assert.equal(claimDiscordRequest(db, body).created, true);
    finishDiscordRequest(db, requestId, { ...scope, status: 'succeeded', runId: detail.run.id, date });
    assert.deepEqual(discordContext(db, scope), { runId: detail.run.id, date });
  }
});

test('모든 항목이 보류이면 모델의 가능한 다음 조작에 엑셀 생성을 넣지 않는다', async t => {
  const db = setup(t), { detail } = invoice(db); let input;
  db.prepare("UPDATE invoice_items SET decision = 'hold' WHERE run_id = ?").run(detail.run.id);
  await interpretDiscordRequest(db, { ...request, text: '왜 다운로드가 안 되지?', runId: detail.run.id },
    model({ action: 'help', date: null }, value => { input = JSON.parse(value.input); }), 'mock-model');
  assert.equal(input.workflow.held, 1);
  assert.ok(!input.workflow.allowedNextActions.includes('rebuild_file'));
});

test('모델의 알 수 없는 실행 action과 잘못된 안내 형식은 업무 실행 없이 거부한다', async t => {
  const db = setup(t);
  for (const answer of [
    { action: 'register_naver', date: null, message: '등록하겠습니다.' },
    { action: 'replace_tracking', date: null, message: '교체 완료' },
    { action: 'create_invoice', date: null, message: { text: '잘못된 구조' } },
    { action: 'help', date: null, message: 'x'.repeat(601) },
  ]) await assert.rejects(interpretDiscordRequest(db, request, model(answer), 'mock-model'), /해석하지 못/);
  assert.equal(db.prepare('SELECT count(*) n FROM invoice_runs').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM discord_requests').get().n, 0);
});
