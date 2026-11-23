import { transaction } from './database.mjs';

const retentionMs = 3 * 24 * 60 * 60 * 1000;
const turnLimit = 5;
const snowflake = /^\d{17,20}$/;
const orderId = /^[A-Za-z0-9_-]{1,80}$/;
const positiveId = id => Number.isSafeInteger(id) && id > 0;
const stringId = (id, pattern = snowflake) => typeof id === 'string' && pattern.test(id);
const nullableId = id => id === null || stringId(id);
const list = (ids, validate) => Array.isArray(ids) && ids.length <= 200 && ids.every(validate);
const scope = body => [body.guildId, body.channelId, body.userId];
const owned = 'guild_id = ? AND channel_id = ? AND user_id = ?';
const recent = 'created_at > ?';
const newest = 'ORDER BY created_at DESC, rowid DESC';
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

const empty = (status, extra) => ({ status, conversationId: null, turns: [], pending: null, ...extra });
const candidateReference = /(?:(?:첫|두|세|네|다섯|[1-9]\d*)\s*번\s*째\s*(?:송장|번호|걸|것|로\s*(?:적용|저장|선택))|마지막\s*(?:송장|번호|것|걸)|그\s*(?:걸로|번호로|송장으로|중에)|그대로\s*(?:진행|적용|저장))/u;
const priorReference = /(?:이어서|계속해서|(?:방금|아까|앞서)\s*말한|그\s*작업에서|위(?:의)?\s*(?:송장|주문|작업|번호))/u;
const followupQuestion = /^(?:(?:그럼|그러면|근데|그런데|그건|그게|그거)\s*(?:왜|어디|언제|뭐|무엇|몇|누가|어떻)|(?:그|이)\s*(?:주문|송장|번호|결과|건|부분|내용)|왜[?？.!]*$)/u;
const applyRequest = /(?:(?:적용|선택|저장|반영|지정|교체|정정)\s*해\s*(?:줘|주세요|라|봐|[.!]?$)|(?:바꿔|고쳐)\s*(?:줘|주세요|라|봐))/u;
const namedProduct = /상품\s*주문\s*번호\s*[:#]?\s*[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/u;

function explicitRuns(text) {
  const namedOrders = text.replace(/상품\s*주문\s*번호\s*[:#]?\s*[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/gu, '');
  return new Set([...namedOrders.matchAll(/(?:^|\s)(?:(?:(송장|주문|상품명\s*정리)\s*)?작업\s*(?:번호\s*)?#?|#)([1-9]\d*)\b/g)]
    .filter(([, domain]) => !domain || domain === '송장').map(([, , id]) => Number(id)).filter(positiveId));
}

export function loadDiscordConversation(db, body, now = Date.now()) {
  const actor = scope(body), { replyToId, text } = body;
  if (!actor.every(id => stringId(id)) || !nullableId(replyToId) || typeof text !== 'string' || text.length > 4000) {
    throw failure('이어갈 대화의 메시지 또는 내용을 확인해 주세요.');
  }
  const cutoff = expiresAt(now);
  if (replyToId) {
    const target = db.prepare(`SELECT conversation_id, pending FROM discord_conversation_turns WHERE ${owned} AND ${recent}
      AND (message_id = ? OR bot_message_id = ?)`).get(...actor, cutoff, replyToId, replyToId);
    return target ? matched(db, actor, cutoff, target.conversation_id, target.pending) : empty('expired');
  }
  const rows = db.prepare(`SELECT conversation_id, run_ids, product_order_ids, pending FROM discord_conversation_turns
    WHERE ${owned} AND ${recent} ${newest}`).all(...actor, cutoff);
  if (!rows.length) return empty('none');
  const latest = new Map(), runIds = explicitRuns(text), tokens = new Set(text.match(/[A-Za-z0-9_-]{1,80}/g) || []);
  const runs = new Set(), orders = new Set();
  for (const row of rows) {
    if (!latest.has(row.conversation_id)) latest.set(row.conversation_id, row);
    if (runIds.size && JSON.parse(row.run_ids).some(id => runIds.has(id))) runs.add(row.conversation_id);
    if (JSON.parse(row.product_order_ids).some(id => tokens.has(id))) orders.add(row.conversation_id);
  }
  const explicitlyNamesProduct = namedProduct.test(text);
  const related = runIds.size ? (orders.size || explicitlyNamesProduct ? runs.intersection(orders) : runs) : orders;
  let pendingRuns = [];
  if (!related.size && !runIds.size && !explicitlyNamesProduct) {
    const reference = text.trim(), selectsCandidate = candidateReference.test(reference);
    if (selectsCandidate || priorReference.test(reference) || followupQuestion.test(reference)) {
      const newestTurns = [...latest.values()];
      if (selectsCandidate || applyRequest.test(reference)) {
        const waiting = newestTurns.filter(row => row.pending !== null);
        for (const row of waiting) related.add(row.conversation_id);
        pendingRuns = waiting.map(row => JSON.parse(row.pending).runId);
      } else {
        const forInvoice = /송장|로젠|네이버|누락|상품\s*주문/.test(reference);
        const newestRelated = forInvoice ? newestTurns.find(row => JSON.parse(row.run_ids).length || JSON.parse(row.product_order_ids).length) : newestTurns[0];
        if (newestRelated) related.add(newestRelated.conversation_id);
      }
    }
  }
  if (related.size === 1) return matched(db, actor, cutoff, [...related][0]);
  if (related.size > 1) {
    const matchingRuns = pendingRuns.length ? pendingRuns : rows.filter(row => related.has(row.conversation_id)).flatMap(row => JSON.parse(row.run_ids));
    return empty('ambiguous', { runIds: [...new Set(matchingRuns)] });
  }
  return empty('none');
}

function matched(db, actor, cutoff, id, anchorPending) {
  const rows = db.prepare(`SELECT user_text AS userText, bot_text AS botText, pending FROM discord_conversation_turns
    WHERE ${owned} AND ${recent} AND conversation_id = ? ${newest} LIMIT ?`).all(...actor, cutoff, id, turnLimit);
  if (!rows.length) return empty('expired');
  const pending = anchorPending === undefined || anchorPending === rows[0].pending ? JSON.parse(rows[0].pending) : null;
  const turns = rows.reverse().map(({ userText, botText }) => ({ userText, botText }));
  return { status: 'matched', conversationId: id, turns, pending };
}

function validPending(pending) {
  return pending === null || pending && Object.keys(pending).length === 5 && positiveId(pending.runId)
    && stringId(pending.viewVersion, /^[a-f0-9]{64}$/) && stringId(pending.groupKey, /^[a-f0-9]{24}$/)
    && list(pending.productOrderIds, id => stringId(id, orderId)) && pending.productOrderIds.length > 0
    && list(pending.choices, item => item && Object.keys(item).length === 2 && stringId(item.trackingNumber, orderId)
      && ['assign', 'replace', 'split'].includes(item.mode)) && pending.choices.length > 0;
}

const redactAttachmentUrls = value => value.replace(/https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[^\s<>]+/gi, '[첨부 링크]');

export function saveDiscordConversation(db, body, now = Date.now()) {
  const { messageId, botMessageId, conversationId, userText, botText, runIds, productOrderIds, pending } = body;
  const actor = scope(body);
  if (![...actor, messageId, botMessageId].every(id => stringId(id)) || messageId === botMessageId || !nullableId(conversationId)
    || typeof userText !== 'string' || userText.length > 4000 || typeof botText !== 'string' || botText.length > 2000
    || !list(runIds, positiveId) || !list(productOrderIds, id => stringId(id, orderId)) || !validPending(pending)) {
    throw failure('보관할 디스코드 업무 대화를 확인해 주세요.');
  }
  const root = conversationId || messageId;
  const payload = [redactAttachmentUrls(userText), redactAttachmentUrls(botText), JSON.stringify([...new Set([...runIds, ...(pending ? [pending.runId] : [])])]),
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
    if (conversationId && !db.prepare(`SELECT 1 FROM discord_conversation_turns WHERE ${owned} AND ${recent}
      AND conversation_id = ? LIMIT 1`).get(...actor, expiresAt(now), conversationId)) {
      throw failure('이어갈 업무 대화가 만료되었습니다.', 'discord_conversation_expired', 409);
    }
    db.prepare(`INSERT INTO discord_conversation_turns (guild_id, channel_id, user_id, message_id, bot_message_id,
      conversation_id, user_text, bot_text, run_ids, product_order_ids, pending, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...actor, messageId, botMessageId, root, ...payload, now);
    return { conversationId: root };
  });
}
