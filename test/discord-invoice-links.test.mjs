import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceLinkLabel, renderInvoiceReferences } from '../lib/discord-invoice-links.mjs';

test('한국 시각 자정과 같은 분의 두 작업을 구분한다', () => {
  const run = { sourceDate: '2026-11-23', createdAt: '2026-11-22T15:05:00Z', sameDayCount: 2 };
  assert.equal(invoiceLinkLabel({ ...run, sameMinuteOrder: 1 }), '11월 23일 오전 12:05 송장 작업 · 1번째');
  assert.equal(invoiceLinkLabel({ ...run, sameMinuteOrder: 2 }), '11월 23일 오전 12:05 송장 작업 · 2번째');
});

test('예전 번호 링크를 교체하고 길이 제한에서 원래 번호나 잘린 링크를 내보내지 않는다', () => {
  const known = new Set([28]), metadata = new Map([[28, { sourceDate: '2026-11-23', createdAt: '2026-11-23T00:52:00Z', sameDayCount: 1 }]]);
  const url = id => `https://system0.example/invoices.html?run=${id}`;
  const oldLink = '송장 작업 [#28](https://system0.example/invoices.html?run=28)';
  assert.equal(renderInvoiceReferences(oldLink, known, metadata, url), `[11월 23일 오전 송장 작업](${url(28)})`);
  assert.equal(renderInvoiceReferences('송장 작업 #28', known, new Map(), url), `[송장 작업 열기](${url(28)})`);
  const shipping = '출고 보드 · 2026-11-23 작업 #28';
  assert.equal(renderInvoiceReferences(shipping, known, metadata, url), shipping);
  const long = '가'.repeat(1978) + ' 송장 작업 #28에서 진행했습니다.';
  const fitted = renderInvoiceReferences(long, known, metadata, url);
  assert.ok(fitted.length <= 2000);
  assert.match(fitted, /11월 23일/);
  assert.doesNotMatch(fitted, /#28|\]\(/);
});
