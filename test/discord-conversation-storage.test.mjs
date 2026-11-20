import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.mjs';
import { initializeDiscordConversations, loadDiscordConversation, pruneDiscordConversations, saveDiscordConversation } from '../lib/discord-conversations.mjs';

const scope = { guildId: '111111111111111111', channelId: '222222222222222222', userId: '333333333333333333' };
const number = (base, offset) => String(base + BigInt(offset));
const userMessage = offset => number(400000000000000000n, offset);
const botMessage = offset => number(500000000000000000n, offset);
const start = Date.parse('2026-11-20T08:00:00Z');
const day = 24 * 60 * 60 * 1000;
const pending = (runId, productOrderId, choices = [{ trackingNumber: '45621523006', mode: 'replace' }]) => ({ runId,
  viewVersion: '1'.repeat(64), groupKey: '2'.repeat(24), productOrderIds: [productOrderId], choices });

function setup(t) {
  const db = openDatabase(':memory:');
  initializeDiscordConversations(db);
  t.after(() => db.close());
  const save = (i, changes = {}, now = start + i * 1000) => saveDiscordConversation(db, { ...scope, messageId: userMessage(i),
    botMessageId: botMessage(i), conversationId: null, userText: '질문 ' + i, botText: '답변 ' + i, runIds: [], productOrderIds: [],
    pending: null, ...changes }, now);
  const load = (text, replyToId = null, actor = scope, now = start + day) => loadDiscordConversation(db, { ...actor, text, replyToId }, now);
  return { db, save, load };
}

test('답장을 가리킨 사람의 대화만 읽고, 같은 대화에서도 답장한 후보가 바뀌면 다시 적용할 수 없습니다', t => {
  const s = setup(t), first = pending(24, '2026111900000001'), newer = { ...first, viewVersion: '3'.repeat(64) };
  const { conversationId } = s.save(1, { pending: first });
  s.save(2, { pending: pending(25, '2026111900000002') });
  assert.equal(s.load('두 번째 걸로 해줘').status, 'ambiguous');
  assert.deepEqual(s.load('두 번째 걸로 해줘', botMessage(1)), { status: 'matched', conversationId,
    turns: [{ userText: '질문 1', botText: '답변 1' }], pending: first });
  const another = { ...scope, userId: '666666666666666666' };
  assert.equal(s.load('두 번째 걸로 해줘', botMessage(1), another).status, 'expired');
  assert.equal(s.load('송장 작업 #24 확인해줘', null, another).status, 'none');
  s.save(3, { conversationId, pending: newer });
  assert.equal(s.load('두 번째 걸로 해줘', botMessage(1)).pending, null);
  assert.deepEqual(s.load('두 번째 걸로 해줘', botMessage(3)).pending, newer);
  s.save(4, { conversationId });
  const final = s.load('그대로 적용해줘', botMessage(3));
  assert.equal(final.pending, null);
  assert.deepEqual(final.turns.map(turn => turn.userText), ['질문 1', '질문 3', '질문 4']);
  assert.equal(s.load('두 번째 걸로 해줘').conversationId, userMessage(2));
});

test('작업번호와 상품주문번호로 대화를 찾고, 새 요청이나 미확인 주문에 다른 대화를 넘기지 않습니다', t => {
  const s = setup(t);
  s.save(1, { pending: pending(24, '2026111900000001') });
  assert.equal(s.load('두 번째 걸로 해줘').conversationId, userMessage(1));
  assert.equal(s.load('내일 출고 묶음 수를 알려줘').status, 'none');
  assert.equal(s.load('오늘 두 번째 출고 작업 수량을 알려줘').status, 'none');
  assert.equal(s.load('상품주문번호 2026111900000003의 두 번째 송장으로 해줘').status, 'none');
  s.save(2, { pending: pending(24, '2026111900000002') });
  assert.equal(s.load('송장 작업 #24의 두 번째 송장').status, 'ambiguous');
  assert.equal(s.load('송장 작업 #24 상품주문번호 #2026111900000002의 두 번째 송장').conversationId, userMessage(2));
  assert.equal(s.load('2026111900000001에 무엇을 확인했지?').conversationId, userMessage(1));
  assert.equal(s.load('주문 작업 #24 상품명 정리해줘').status, 'none');
});

test('3일을 넘긴 메시지는 대화에 다시 들어오지 않고 남은 최근 5턴만 반환합니다', t => {
  const s = setup(t), privateUrl = 'https://cdn.discordapp.com/attachments/1/2/orders.xlsx';
  const { conversationId } = s.save(1, { userText: privateUrl }, start);
  assert.equal(s.load('확인해줘', botMessage(1)).turns[0].userText, '[첨부 링크]');
  assert.deepEqual(s.save(1, { userText: privateUrl }, start + 10), { conversationId });
  assert.throws(() => s.save(1, { userText: '다른 글' }, start + 10), { code: 'discord_conversation_conflict' });
  for (let i = 2; i <= 7; i++) s.save(i, { conversationId }, start + day + i);
  assert.equal(s.load('확인해줘', botMessage(1), scope, start + 3 * day).status, 'expired');
  const newer = s.load('확인해줘', botMessage(7), scope, start + 3 * day);
  assert.deepEqual(newer.turns.map(turn => turn.botText), ['답변 3', '답변 4', '답변 5', '답변 6', '답변 7']);
  assert.equal(pruneDiscordConversations(s.db, start + 3 * day), 1);
  assert.equal(pruneDiscordConversations(s.db, start + 4 * day + 7), 6);
  assert.throws(() => s.save(8, { conversationId }, start + 4 * day + 8), { code: 'discord_conversation_expired' });
});
