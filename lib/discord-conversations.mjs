import { transaction } from './database.mjs';
import { redactDiscordCredentials } from './discord-trace.mjs';

const dayMs = 24 * 60 * 60 * 1000;
const retentionMs = 3 * dayMs;
const koreaOffsetMs = 9 * 60 * 60 * 1000;
const turnLimit = 5;
const olderConversationLimit = 3;
const snowflake = /^\d{17,20}$/;
const orderId = /^[A-Za-z0-9_-]{1,80}$/;
const positiveId = id => Number.isSafeInteger(id) && id > 0;
const stringId = (id, pattern = snowflake) => typeof id === 'string' && pattern.test(id);
const nullableId = id => id === null || stringId(id);
const list = (ids, validate) => Array.isArray(ids) && ids.length <= 200 && ids.every(validate);
const scope = body => [body.guildId, body.channelId, body.userId];
const channel = 'guild_id = ? AND channel_id = ?';
const owned = `${channel} AND user_id = ?`;
const recent = 'created_at > ?';
const newest = 'ORDER BY created_at DESC, rowid DESC';
const turnFields = 'conversation_id AS conversationId, user_text AS userText, bot_text AS botText';
const historyTurn = ({ conversationId, userText, botText }) => ({ conversationId, userText, botText });
const expiresAt = now => now - retentionMs;
const failure = (message, code = 'discord_conversation_invalid', httpStatus = 400) =>
  Object.assign(new Error(message), { discordWorkflow: true, code, httpStatus });

export function initializeDiscordConversations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS discord_conversation_turns (
    message_id TEXT PRIMARY KEY, bot_message_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL,
    guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
    user_text TEXT NOT NULL, bot_text TEXT NOT NULL, run_ids TEXT NOT NULL, product_order_ids TEXT NOT NULL,
    pending TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS discord_conversation_owner ON discord_conversation_turns(guild_id, channel_id, user_id, created_at);
  CREATE INDEX IF NOT EXISTS discord_conversation_expiry ON discord_conversation_turns(created_at);`);
  pruneDiscordConversations(db);
}

export function pruneDiscordConversations(db, now = Date.now()) {
  return db.prepare('DELETE FROM discord_conversation_turns WHERE created_at <= ?').run(expiresAt(now)).changes;
}

function koreanDayStart(day) {
  const start = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00+09:00`) : NaN;
  if (!Number.isFinite(start) || new Date(start + koreaOffsetMs).toISOString().slice(0, 10) !== day) {
    throw failure('대화를 조회할 실제 한국 날짜를 확인해 주세요.');
  }
  return start;
}

export function loadTodayDiscordTurns(db, actorScope, day) {
  const actor = scope(actorScope);
  if (!actor.every(id => stringId(id))) throw failure('대화를 조회할 직원을 확인해 주세요.');
  const start = koreanDayStart(day);
  return db.prepare(`SELECT ${turnFields} FROM discord_conversation_turns
    WHERE ${channel} AND created_at >= ? AND created_at < ? ORDER BY created_at, rowid`).all(...actor.slice(0, 2), start, start + dayMs).map(historyTurn);
}

function loadOlderDiscordTurns(db, actor, cutoff, day, text) {
  const before = koreanDayStart(day);
  const terms = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  const rows = db.prepare(`SELECT ${turnFields} FROM discord_conversation_turns
    WHERE ${channel} AND ${recent} AND created_at < ? ${newest}`).all(...actor.slice(0, 2), cutoff, before);
  const anchors = new Map();
  for (const row of rows) {
    if (anchors.has(row.conversationId)) continue;
    const content = `${row.userText} ${row.botText}`.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    if (terms.every(term => content.includes(term))) anchors.set(row.conversationId, row);
    if (anchors.size === olderConversationLimit) break;
  }
  const counts = new Map();
  const included = rows.filter(row => {
    if (!anchors.has(row.conversationId)) return false;
    if (anchors.get(row.conversationId) === row) return true;
    const count = counts.get(row.conversationId) || 0;
    if (count >= turnLimit - 1) return false;
    counts.set(row.conversationId, count + 1);
    return true;
  });
  return { turns: included.reverse().map(historyTurn) };
}

const empty = (status, extra) => ({ status, conversationId: null, turns: [], pending: null, ...extra });
const candidateReference = /(?:(?:첫|두|세|네|다섯|[1-9]\d*)\s*번\s*째\s*(?:송장|번호|걸|것|로\s*(?:적용|저장|선택))|마지막\s*(?:송장|번호|것|걸)|그\s*(?:걸로|번호로|송장으로)|그대로\s*(?:진행|적용|저장))/u;
const priorReference = /(?:이어서|계속해서|(?:방금|아까|앞서)\s*말한|그\s*작업에서|위(?:의)?\s*(?:송장|주문|작업|번호))/u;
const pairedSelection = /(?:원\s*송장|재\s*(?:출력|발급)|이번\s*(?:파일|송장)|새(?:로)?\s*(?:송장|뽑은)|현재\s*(?:적용|연결|매칭|저장|번호))/u;
const followupQuestion = /^(?:(?:그럼|그러면|근데|그런데|그건|그게|그거)\s*(?:왜|어디|언제|뭐|무엇|몇|누가|어떻)|(?:그|이)\s*(?:주문|송장|번호|결과|건|부분|내용)|왜[?？.!]*$)/u;
const resultReference = /^(?:그\s*중(?:\s*에(?:서)?|\s|$)|거기(?:에)?서|그\s*목록에서)/u;
const scopeCorrection = /말고.+(?:말\s*(?:이야|야|이에요|입니다)|기준(?:으로)?)[.?!？]*$/su;
const scopeFragment = /^(?:(?:신규|발송\s*대기|등록된|저장된|네이버)\s*주문(?:\s*현황)?|출고\s*(?:보드|목록))\s*(?:에서|으?로|기준(?:으로)?)(?:요)?[.?!？]*$/u;
const trackingMutation = /(?:적용|선택|저장|반영|지정|교체|정정|배정|수정|처리)(?:만)?\s*(?:해\s*(?:줘|주세요|라|봐|(?=[.!\s]*$))|하라|하세요)|(?:바꿔|고쳐|써)\s*(?:줘|주세요|라|봐|(?=[.!\s]*$))|(?:고친|바꾼|적용한|교체한)\s*(?:뒤|다음|후)/;
const compoundTrackingMutation = /(?:적용|선택|저장|반영|지정|교체|정정|배정|수정|처리)\s*하고\s+[^.!?\n]{0,60}(?:만들어|생성해|보내|저장해|내려|확인해|결과\s*알려)\s*(?:줘|주세요|라|봐)/;
const notTrackingMutation = /하지\s*(?:마|말)|말아|하지\s*않|(?:적용|선택|저장|반영|교체|정정|변경|처리)\s*(?:가능|할\s*수|할지|해\s*(?:줘도|도\s*되|주면))|[?？]\s*$/;
const namedProduct = /상품\s*주문\s*번호\s*[:#]?\s*[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/u;

export function discordTrackingChangeRequested(text) {
  return !notTrackingMutation.test(text) && (trackingMutation.test(text) || compoundTrackingMutation.test(text));
}

function explicitRunReferences(text) {
  const namedOrders = text.replace(/상품\s*주문\s*번호\s*[:#]?\s*[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/gu, '');
  const references = [...namedOrders.matchAll(/(?:^|\s)(?:(?:(송장|주문|상품명\s*정리)\s*)?작업\s*(?:번호\s*)?#?|#)([1-9]\d*)\b/g)];
  const runIds = new Set(references.filter(([, domain]) => !domain || domain === '송장').map(([, , id]) => Number(id)).filter(positiveId));
  return { runIds, explicitlyNamesRun: references.length > 0 };
}

export function loadDiscordConversation(db, body, now = Date.now()) {
  const actor = scope(body), { replyToId, text, useWorkHistory = false, olderHistoryOnly = false, historyDay } = body;
  if (!actor.every(id => stringId(id)) || !nullableId(replyToId) || typeof text !== 'string' || text.length > 4000
      || typeof useWorkHistory !== 'boolean' || typeof olderHistoryOnly !== 'boolean' || olderHistoryOnly && replyToId) {
    throw failure('이어갈 대화의 메시지 또는 내용을 확인해 주세요.');
  }
  const cutoff = expiresAt(now);
  if (olderHistoryOnly) return loadOlderDiscordTurns(db, actor, cutoff, historyDay, text);
  const whereScope = useWorkHistory ? channel : owned;
  const scopeIds = useWorkHistory ? actor.slice(0, 2) : actor;
  if (replyToId) {
    const target = db.prepare(`SELECT conversation_id, pending FROM discord_conversation_turns WHERE ${whereScope} AND ${recent}
      AND (message_id = ? OR bot_message_id = ?)`).get(...scopeIds, cutoff, replyToId, replyToId);
    return target ? matched(db, scopeIds, cutoff, target.conversation_id, target.pending, useWorkHistory) : empty('expired');
  }
  const rows = db.prepare(`SELECT conversation_id, run_ids, product_order_ids, pending FROM discord_conversation_turns
    WHERE ${whereScope} AND ${recent} ${newest}`).all(...scopeIds, cutoff);
  if (!rows.length) return empty('none');
  const { runIds, explicitlyNamesRun } = explicitRunReferences(text);
  const latest = new Map(), tokens = new Set(text.match(/[A-Za-z0-9_-]{1,80}/g) || []);
  const runs = new Set(), orders = new Set();
  for (const row of rows) {
    if (!latest.has(row.conversation_id)) latest.set(row.conversation_id, row);
    if (runIds.size && JSON.parse(row.run_ids).some(id => runIds.has(id))) runs.add(row.conversation_id);
    if (JSON.parse(row.product_order_ids).some(id => tokens.has(id))) orders.add(row.conversation_id);
  }
  const explicitlyNamesProduct = namedProduct.test(text);
  const hasExplicitTarget = explicitlyNamesRun || explicitlyNamesProduct || [...tokens].some(token => /^\d{16,19}$/.test(token));
  const related = runIds.size ? (orders.size || explicitlyNamesProduct ? runs.intersection(orders) : runs) : orders;
  const reference = text.trim(), selectsCandidate = candidateReference.test(reference), appliesSelection = discordTrackingChangeRequested(reference);
  const selectsPaired = pairedSelection.test(reference) && appliesSelection;
  let pendingRuns = [];
  if (!related.size && !runIds.size && !explicitlyNamesProduct && (!useWorkHistory || !hasExplicitTarget)) {
    const refersToLastResult = resultReference.test(reference) || scopeCorrection.test(reference) || scopeFragment.test(reference);
    if (selectsCandidate || selectsPaired || refersToLastResult || priorReference.test(reference) || followupQuestion.test(reference)) {
      const newestTurns = [...latest.values()];
      if (selectsCandidate || selectsPaired || appliesSelection) {
        const waiting = newestTurns.filter(row => row.pending !== null && (!selectsPaired || selectsCandidate || JSON.parse(row.pending).trackingGroupKeys));
        for (const row of waiting) related.add(row.conversation_id);
        pendingRuns = waiting.map(row => JSON.parse(row.pending).runId);
      } else if (!useWorkHistory) {
        const forInvoice = !refersToLastResult && /송장|로젠|네이버|누락|상품\s*주문/.test(reference);
        const newestRelated = forInvoice ? newestTurns.find(row => JSON.parse(row.run_ids).length || JSON.parse(row.product_order_ids).length) : newestTurns[0];
        if (newestRelated) related.add(newestRelated.conversation_id);
      }
    }
  }
  if (related.size === 1) return matched(db, scopeIds, cutoff, [...related][0], undefined, useWorkHistory);
  if (related.size > 1) {
    const matchingRuns = pendingRuns.length ? pendingRuns : rows.filter(row => related.has(row.conversation_id)).flatMap(row => JSON.parse(row.run_ids));
    return empty('ambiguous', { runIds: [...new Set(matchingRuns)] });
  }
  return empty('none');
}

function matched(db, scopeIds, cutoff, id, anchorPending, useWorkHistory) {
  const rows = db.prepare(`SELECT ${useWorkHistory ? '' : 'user_text AS userText, bot_text AS botText,'} pending FROM discord_conversation_turns
    WHERE ${useWorkHistory ? channel : owned} AND ${recent} AND conversation_id = ? ${newest} LIMIT ?`).all(...scopeIds, cutoff, id, useWorkHistory ? 1 : turnLimit);
  if (!rows.length) return empty('expired');
  const pending = anchorPending === undefined || anchorPending === rows[0].pending ? JSON.parse(rows[0].pending) : null;
  const turns = useWorkHistory ? [] : rows.map(({ userText, botText }) => ({ userText, botText })).reverse();
  return { status: 'matched', conversationId: id, turns, pending };
}

function validPending(pending) {
  if (pending === null) return true;
  if (!pending || !positiveId(pending.runId) || !stringId(pending.viewVersion, /^[a-f0-9]{64}$/)
    || !list(pending.productOrderIds, id => stringId(id, orderId)) || !pending.productOrderIds.length) return false;
  const groupKey = id => stringId(id, /^[a-f0-9]{24}$/);
  if (Object.hasOwn(pending, 'trackingGroupKeys')) return Object.keys(pending).length === 4
    && list(pending.trackingGroupKeys, groupKey) && pending.trackingGroupKeys.length > 0 && pending.trackingGroupKeys.length <= 10
    && new Set(pending.trackingGroupKeys).size === pending.trackingGroupKeys.length;
  return Object.keys(pending).length === 5 && groupKey(pending.groupKey)
    && list(pending.choices, item => item && Object.keys(item).length === 2 && stringId(item.trackingNumber, orderId)
      && ['assign', 'replace', 'split'].includes(item.mode)) && pending.choices.length > 0;
}

export function saveDiscordConversation(db, body, now = Date.now()) {
  const { messageId, botMessageId, conversationId, userText, botText, runIds, productOrderIds, pending, useWorkHistory = false } = body;
  const actor = scope(body);
  if (![...actor, messageId, botMessageId].every(id => stringId(id)) || messageId === botMessageId || !nullableId(conversationId)
    || typeof userText !== 'string' || userText.length > 4000 || typeof botText !== 'string' || botText.length > 2000
    || !list(runIds, positiveId) || !list(productOrderIds, id => stringId(id, orderId)) || !validPending(pending)
    || typeof useWorkHistory !== 'boolean') {
    throw failure('보관할 디스코드 업무 대화를 확인해 주세요.');
  }
  const root = conversationId || messageId;
  const payload = [redactDiscordCredentials(userText), redactDiscordCredentials(botText), JSON.stringify([...new Set([...runIds, ...(pending ? [pending.runId] : [])])]),
    JSON.stringify([...new Set([...productOrderIds, ...(pending?.productOrderIds || [])])]), pending ? JSON.stringify(pending) : null];
  return transaction(db, () => {
    pruneDiscordConversations(db, now);
    const existing = db.prepare(`SELECT guild_id, channel_id, user_id, message_id, bot_message_id, conversation_id,
      user_text, bot_text, run_ids, product_order_ids, pending FROM discord_conversation_turns
      WHERE message_id IN (?, ?) OR bot_message_id IN (?, ?)`).all(messageId, botMessageId, messageId, botMessageId);
    if (existing.length) {
      const expected = [...actor, messageId, botMessageId, root, ...payload];
      if (existing.length !== 1 || Object.values(existing[0]).some((value, i) => value !== expected[i])) {
        throw failure('같은 디스코드 메시지에 이미 다른 업무 기록이 있습니다.', 'discord_conversation_conflict', 409);
      }
      return { conversationId: root };
    }
    const scopeIds = useWorkHistory ? actor.slice(0, 2) : actor;
    if (conversationId && !db.prepare(`SELECT 1 FROM discord_conversation_turns WHERE ${useWorkHistory ? channel : owned} AND ${recent}
      AND conversation_id = ? LIMIT 1`).get(...scopeIds, expiresAt(now), conversationId)) {
      throw failure('이어갈 업무 대화가 만료되었습니다.', 'discord_conversation_expired', 409);
    }
    db.prepare(`INSERT INTO discord_conversation_turns (guild_id, channel_id, user_id, message_id, bot_message_id,
      conversation_id, user_text, bot_text, run_ids, product_order_ids, pending, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...actor, messageId, botMessageId, root, ...payload, now);
    return { conversationId: root };
  });
}
