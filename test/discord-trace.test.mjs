import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiscordTrace, discordTraceDirectory, redactDiscordCredentials, redactDiscordText } from '../lib/discord-trace.mjs';

function testDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'system0-discord-trace-'));
  t.after(() => {
    for (const filename of readdirSync(directory)) unlinkSync(path.join(directory, filename));
    rmdirSync(directory);
  });
  return directory;
}

test('한국어 대화의 파일 암호와 일반 자격 증명은 가리고 업무 번호는 남긴다', () => {
  const message = [
    '네이버주문파일 비밀번호는 6283이야. 송장 작업 #28 확인해줘.',
    '비번 8877, 파일 암호: "pass with spaces", password is secret!phrase, {"password":"nested-secret"}',
    'DISCORD_BOT_TOKEN=opaque-credential Authorization: Bearer another-credential api key: labeled-value',
    '{"Authorization":"Basic Z3Vlc3Q6Z3Vlc3Q="} X-System0-Discord-Key: socket-credential',
    'https://cdn.discordapp.com/attachments/123/456/orders.xlsx?ex=secret-signed-url',
    'https://media.discordapp.net/ephemeral-attachments/123/456/labels.xlsx?ex=secret-ephemeral-url',
    'https://discord.com/api/webhooks/123/webhook-secret',
    'https://system0.example/invoices.html?run=28&token=url-credential',
    '빈 문구에서 따로 지정한 secret, literal-fragment-a.',
  ].join('\n');
  const result = redactDiscordCredentials(message, ['literal-fragment-a']);
  for (const secret of ['6283', '8877', 'pass with spaces', 'secret!phrase', 'nested-secret', 'opaque-credential', 'labeled-value',
    'another-credential', 'Z3Vlc3Q6Z3Vlc3Q=', 'socket-credential', 'secret-signed-url', 'secret-ephemeral-url',
    'webhook-secret', 'url-credential', 'literal-fragment-a']) assert.ok(!result.includes(secret), '자격 증명 노출');
  assert.match(result, /송장 작업 #28 확인해줘/);
  assert.match(result, /invoices\.html\?run=28&token=\[가림\]/);
  assert.match(result, /\[첨부 링크\]/);
  assert.equal(redactDiscordCredentials('prefix/overlap/secret', ['overlap', 'overlap/secret']), 'prefix/[가림]');
  assert.equal(redactDiscordCredentials('파일 비밀번호 알려줄게요 7392. 토큰은 opaque-local-key 이거야'), '파일 비밀번호 알려줄게요 [가림] 토큰은 [가림] 이거야');
  assert.equal(redactDiscordText('`7392`'), '[가림]');
  assert.equal(redactDiscordText('15706273926180727005', ['7392']), '15706273926180727005');
  assert.equal(redactDiscordText('수취인: 가상 이름, 배송지: 서울시 가상로 12'), '수취인: [가림], 배송지: [가림]');
  const contact = 'sample@example.com, 010-1234-5678, 0502-2345-6789, +82 10 3333 4444, 02-777-8888';
  assert.equal(redactDiscordCredentials(contact), contact);
  assert.equal(redactDiscordText(contact), '[가림], [가림], [가림], [가림], [가림]');
});

test('전용 경로를 해결하고 보호된 일별 로그를 남기며 오래된 진단 파일만 정리한다', t => {
  assert.equal(discordTraceDirectory({ STATE_DIRECTORY: '/var/lib/system0-discord:/var/lib/other' }),
    path.join('/var/lib/system0-discord', 'discord-trace'));
  assert.equal(discordTraceDirectory({ LOCALAPPDATA: '/local' }), path.join('/local', 'system0', 'discord-trace'));
  const directory = testDirectory(t), errors = [];
  writeFileSync(path.join(directory, '2000-01-01.jsonl'), 'expired');
  writeFileSync(path.join(directory, 'keep.txt'), 'unrelated');
  const trace = createDiscordTrace({ directory, secrets: ['configured-secret'], onError: error => errors.push(error) });
  trace({ stage: 'gateway.received', requestId: '111111111111111111', text: '암호는 2222, sample@example.com, configured-secret',
    nested: { phone: '01012345678', naverPassword: 'hidden-password', headers: { authorization: 'hidden-token' },
      recipientName: '테스트수취인', safe: 28, response: { status: 200 }, buffer: Buffer.from('raw-file') }, schema: 20 });
  trace({ stage: 'discord.delivered', requestId: '111111111111111111', done: true, mode: 'export' });
  assert.deepEqual(errors, []);
  const [filename, other] = readdirSync(directory).sort();
  assert.match(filename, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  assert.equal(other, 'keep.txt');
  const file = path.join(directory, filename), body = readFileSync(file, 'utf8');
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  for (const sensitive of ['2222', 'sample@example.com', 'configured-secret', '01012345678', 'hidden-password',
    'hidden-token', '테스트수취인', 'raw-file']) assert.ok(!body.includes(sensitive), '진단 파일에 민감정보 노출');
  const [first, second] = body.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(first.schema, 1);
  assert.equal(first.stage, 'gateway.received');
  assert.equal(first.nested.safe, 28);
  assert.equal(first.nested.response.status, 200);
  assert.ok(Number.isFinite(Date.parse(first.timestamp)));
  assert.equal(second.stage, 'discord.delivered');
  assert.equal(second.requestId, first.requestId);
  assert.equal(second.mode, 'export');
});

test('큰 이벤트는 식별자를 남겨 제한하고 저장 오류가 업무 처리로 전파되지 않는다', t => {
  const directory = testDirectory(t), trace = createDiscordTrace({ directory });
  const fields = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i), '큰'.repeat(3000)]));
  fields.cycle = fields;
  trace({ requestId: '222222222222222222', stage: 'tool.result', fields });
  const filename = readdirSync(directory)[0], line = readFileSync(path.join(directory, filename), 'utf8');
  assert.ok(Buffer.byteLength(line) <= 16 * 1024);
  const record = JSON.parse(line);
  assert.equal(record.requestId, '222222222222222222');
  assert.equal(record.stage, 'tool.result');
  assert.equal(record.truncated, true);
  const blocked = path.join(directory, 'not-a-directory');
  writeFileSync(blocked, 'untouched');
  let failures = 0;
  const failed = createDiscordTrace({ directory: blocked, onError: () => { failures++; throw new Error('error handler'); } });
  assert.doesNotThrow(() => failed({ stage: 'tool.failed' }));
  assert.doesNotThrow(() => failed({ stage: 'tool.failed' }));
  assert.equal(failures, 1);
  assert.equal(readFileSync(blocked, 'utf8'), 'untouched');
});
