import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/database.mjs';
import { initializeDiscordConversations, loadDiscordConversation, loadTodayDiscordTurns, pruneDiscordConversations,
  saveDiscordConversation } from '../lib/discord-conversations.mjs';

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

test('대화 기록에서도 메시지에 적은 엑셀 암호를 가린다', t => {
  const s = setup(t);
  s.save(1, { userText: '네이버주문파일 비밀번호는 8395이야. 송장 작업 #28 파일 만들어줘.' });
  const stored = s.db.prepare('SELECT user_text FROM discord_conversation_turns WHERE message_id = ?').get(userMessage(1));
  assert.match(stored.user_text, /비밀번호는 \[가림\]/);
  assert.match(stored.user_text, /송장 작업 #28/);
  assert.equal(stored.user_text.includes('8395'), false);
});

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
  assert.equal(s.load('송장 작업 #24 상품주문번호 2026111900000003의 두 번째 송장으로 해줘').status, 'none');
  s.save(2, { pending: pending(24, '2026111900000002') });
  assert.equal(s.load('송장 작업 #24의 두 번째 송장').status, 'ambiguous');
  assert.equal(s.load('송장 작업 #24 상품주문번호 #2026111900000002의 두 번째 송장').conversationId, userMessage(2));
  assert.equal(s.load('2026111900000001에 무엇을 확인했지?').conversationId, userMessage(1));
  assert.equal(s.load('주문 작업 #24 상품명 정리해줘').status, 'none');
});

test('실제 송장 확인은 최신 메시지의 명시 승인 또는 미리보기에 답장한 직원에게 연결된다', t => {
  const s = setup(t), productOrderId = '2026111900000001';
  const preview = { runId: 24, viewVersion: '1'.repeat(64), productOrderIds: [productOrderId], manualResolutions: [{
    productOrderId, trackingNumber: '45621523006', mode: 'separate', usedTrackingNumbers: [], unusedTrackingNumbers: [],
  }] };
  const colleague = { ...scope, userId: '666666666666666666' };
  const load = (text, actor = scope, replyToId = null, elapsed = 10_000) => loadDiscordConversation(s.db,
    { ...actor, text, replyToId, useWorkHistory: true }, start + elapsed);
  s.save(1, { pending: preview });
  assert.deepEqual(load('그래, 그대로 적용해줘').pending, preview);
  assert.equal(load('확인').pending, null);
  assert.equal(load('적용해줘', colleague).pending, null);
  assert.equal(load('적용해줘', scope, null, day).pending, null);
  assert.deepEqual(load('적용해줘', colleague, botMessage(1)).pending, preview);
  s.save(2, { ...colleague });
  assert.equal(load('적용해줘').pending, null);
});

test('멘션 없는 후속 질문은 내 관련 대화를 찾고, 새 업무와 확인 대기 없는 송장 적용은 따로 처리합니다', t => {
  const s = setup(t), employee = { ...scope, userId: '666666666666666666' };
  const { conversationId } = s.save(1, { runIds: [24], userText: '어제 송장 검토 결과 조회해줘' });
  s.save(2, { userText: '오늘 양손프리 출고 수량 알려줘' });
  s.save(3, { ...employee, pending: pending(25, '2026111900000002') });
  assert.equal(s.load('그럼 왜 누락됐어?').conversationId, conversationId);
  assert.equal(s.load('그 결과에서 왜 차이가 나?').conversationId, userMessage(2));
  assert.equal(s.load('아까 말한 송장으로 적용해 줘').status, 'none');
  assert.equal(s.load('재출력이야. 두 번째 걸로 적용해줘').status, 'none');

  s.save(4, { conversationId, pending: pending(24, '2026111900000001') });
  assert.equal(s.load('두 번째 번호가 뭐였지?').conversationId, conversationId);
  assert.equal(s.load('재출력이야. 두 번째 걸로 적용해줘').conversationId, conversationId);
  assert.equal(s.load('오늘 양손프리 출고 수량 알려줘').status, 'none');
  assert.equal(s.load('그럼 오늘 양손프리 출고 수량 알려줘').status, 'none');
  s.save(5, { runIds: [22], pending: pending(26, '2026111900000003') });
  assert.deepEqual(s.load('두 번째 걸로 적용해줘'), { status: 'ambiguous', conversationId: null, turns: [], pending: null, runIds: [26, 24] });
  assert.equal(s.load('두 번째 걸로 적용해줘', null, employee).conversationId, userMessage(3));

  s.save(6, { userText: '오늘 양손프리 출고 수량 알려줘' });
  assert.equal(s.load('그럼 몇 묶음이야?').conversationId, userMessage(6));
  assert.equal(s.load('그럼 왜 누락됐어?').conversationId, userMessage(5));
  assert.equal(s.load('두 번째 번호가 뭐였지?').status, 'ambiguous');
});

test('출고 조회의 대상 정정, 목록 안 질문, 범위만 답한 메시지를 같은 대화에 연결합니다', t => {
  const s = setup(t);
  s.save(1, { pending: pending(24, '2026111900000001') });
  const opening = '오늘 양손프리 출고 수량 알려줘';
  const correction = '시스템에 등록된것 말고 현재 주문들어와있는것 중에 준비해야할것들말야';
  const subset = '그중에 양손프리가 몇개야?';
  const { conversationId } = s.save(2, { userText: opening, botText: '출고 보드에 집계된 주문은 없습니다.' });

  assert.equal(s.load(correction).conversationId, conversationId);
  s.save(3, { conversationId, userText: correction, botText: '네이버 신규 주문에 준비할 상품이 22개 있습니다.' });
  assert.equal(s.load(subset).conversationId, conversationId);
  assert.equal(s.load('그 중에서 가장 많이 들어온 상품은 뭐야?').conversationId, conversationId);
  s.save(4, { conversationId, userText: subset, botText: '어느 목록을 기준으로 할까요?' });

  const resolved = s.load('신규주문에서');
  assert.equal(resolved.conversationId, conversationId);
  assert.deepEqual(resolved.turns.map(turn => turn.userText), [opening, correction, subset]);
  assert.equal(resolved.pending, null);
  assert.equal(s.load('발송 대기 주문 기준으로요').conversationId, conversationId);
  assert.equal(s.load('오늘 신규주문에서 수유 쿠션이 몇 개인지 알려줘').status, 'none');
  assert.equal(s.load('첫 번째 송장으로 교체해줘').conversationId, userMessage(1));
});

test('한국 시간 자정부터 같은 업무 채널의 당일 대화 전체를 시간순으로 읽습니다', t => {
  const s = setup(t), midnight = Date.parse('2026-11-23T00:00:00+09:00');
  const colleague = { ...scope, userId: '666666666666666666' };
  s.save(1, { userText: '전날 마지막 대화' }, midnight - 1);
  s.save(2, { userText: '오늘 첫 대화' }, midnight);
  for (let i = 3; i <= 9; i++) s.save(i, { ...(i % 2 ? colleague : scope) }, midnight + Math.floor(i / 2));
  s.save(10, { channelId: '777777777777777777' }, midnight + 10);
  s.save(11, { guildId: '888888888888888888' }, midnight + 11);
  s.save(12, { userText: '다음 날 첫 대화' }, midnight + day);

  const turns = loadTodayDiscordTurns(s.db, scope, '2026-11-23');
  assert.deepEqual(turns.map(turn => turn.conversationId), Array.from({ length: 8 }, (_, i) => userMessage(i + 2)));
  assert.deepEqual(turns[0], { conversationId: userMessage(2), userText: '오늘 첫 대화', botText: '답변 2' });
  assert.deepEqual(loadTodayDiscordTurns(s.db, colleague, '2026-11-23'), turns);
  assert.throws(() => loadTodayDiscordTurns(s.db, scope, '2026-11-31'), /실제 한국 날짜/);
});

test('지난 대화는 요청할 때만 같은 채널의 3일 보관 범위에서 키워드와 관련 대화를 찾습니다', t => {
  const s = setup(t), midnight = Date.parse('2026-11-23T00:00:00+09:00'), now = midnight + 60_000;
  const colleague = { ...scope, userId: '666666666666666666' };
  s.save(1, { userText: '오래된 양손프리 출고 대화' }, now - 3 * day);
  s.save(2, { userText: '보관 경계 안의 대화' }, now - 3 * day + 1);
  const { conversationId } = s.save(3, { ...colleague, userText: '어제 양손 프리 출고 수량 알려줘' }, midnight - 10_000);
  for (let i = 4; i <= 9; i++) s.save(i, { ...colleague, conversationId }, midnight - 10_000 + i);
  s.save(10, { userText: '관련 없는 대화' }, midnight - 500);
  s.save(11, { channelId: '777777777777777777', userText: '다른 채널 양손프리 출고 대화' }, midnight - 100);
  s.save(12, { guildId: '888888888888888888', userText: '다른 서버 양손프리 출고 대화' }, midnight - 1);
  s.save(13, { userText: '오늘 양손프리 출고 대화' }, midnight);

  const past = (text = '', historyDay = '2026-11-23') => loadDiscordConversation(s.db,
    { ...scope, text, replyToId: null, historyDay, olderHistoryOnly: true }, now);
  const { turns } = past('양손프리 출고');
  assert.deepEqual(turns.map(turn => turn.userText), ['어제 양손 프리 출고 수량 알려줘', '질문 6', '질문 7', '질문 8', '질문 9']);
  assert.ok(turns.every(turn => turn.conversationId === conversationId));
  assert.equal(past('관련 없는 대화').turns[0].userText, '관련 없는 대화');
  assert.equal(past('보관 경계').turns[0].userText, '보관 경계 안의 대화');
  assert.deepEqual(past('없는 키워드').turns, []);
  assert.throws(() => past('', '2026-02-30'), /실제 한국 날짜/);
});

test('업무 채널에서 다른 직원이 대화를 이어받아도 기존 승인 조건과 채널 경계를 지킵니다', t => {
  const s = setup(t);
  const colleague = { ...scope, userId: '666666666666666666' };
  const otherChannel = { ...colleague, channelId: '777777777777777777' };
  const load = (text, replyToId = null, actor = colleague) => loadDiscordConversation(s.db,
    { ...actor, text, replyToId, useWorkHistory: true }, start + day);
  const original = pending(24, '2026111900000001');
  const { conversationId } = s.save(1, { pending: original });

  assert.deepEqual(load('두 번째 걸로 교체해줘'), { status: 'matched', conversationId, turns: [], pending: original });
  assert.deepEqual(load('이 주문이 뭐야?', botMessage(1)), { status: 'matched', conversationId, turns: [], pending: original });
  assert.equal(load('송장 작업 #24 상태 알려줘').conversationId, conversationId);
  assert.equal(load('상품주문번호 2026111900000001을 조회해줘').conversationId, conversationId);
  assert.equal(load('두 번째 걸로 교체해줘', botMessage(1), otherChannel).status, 'expired');
  assert.equal(load('그중에 양손프리가 몇개야?').status, 'none');
  assert.equal(load('신규주문에서').status, 'none');
  assert.equal(s.load('두 번째 걸로 교체해줘', botMessage(1), colleague).status, 'expired');
  assert.throws(() => s.save(2, { ...otherChannel, conversationId, useWorkHistory: true }), { code: 'discord_conversation_expired' });
  assert.throws(() => s.save(2, { ...colleague, conversationId }), { code: 'discord_conversation_expired' });
  assert.deepEqual(s.save(2, { ...colleague, conversationId, useWorkHistory: true }), { conversationId });
  assert.equal(load('두 번째 걸로 교체해줘', botMessage(1)).pending, null);

  s.save(3, { pending: pending(25, '2026111900000002') });
  s.save(4, { ...colleague, pending: pending(26, '2026111900000003') });
  assert.deepEqual(load('두 번째 걸로 적용해줘'), { status: 'ambiguous', conversationId: null, turns: [], pending: null, runIds: [26, 25] });
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
