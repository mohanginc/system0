import { callLlm } from './llm.mjs';
import { readFileSync } from 'node:fs';
import { invoiceView } from './invoices.mjs';

const intentActions = ['create_invoice', 'replace_invoice', 'download_file', 'rebuild_file', 'check_registration', 'show_status', 'help'];
const actions = [...intentActions, 'review_tracking', 'select_tracking', 'replace_tracking', 'invoice_agent'];
const guide = readFileSync(new URL('../prompts/discord-workflows.md', import.meta.url), 'utf8').trim();
const snowflake = /^\d{17,20}$/;
const failure = (message, code, httpStatus = 400, request) => Object.assign(new Error(message),
  { code, httpStatus, discordWorkflow: true, ...(request ? { request } : {}) });

export function initializeDiscordWorkflow(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS discord_requests (
    request_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
    action TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
    run_id INTEGER REFERENCES invoice_runs(id), date TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS discord_requests_context ON discord_requests(guild_id, channel_id, finished_at);
  INSERT OR IGNORE INTO llm_purposes (code, name) VALUES ('discord_requests', '디스코드 업무 요청 해석');
  UPDATE discord_requests SET status = 'interrupted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE status = 'running';`);
}

function validateDate(date) {
  if (date === null || date === undefined) return null;
  const time = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !date.startsWith('0000')
    ? Date.parse(date + 'T00:00:00Z') : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) {
    throw failure('요청 날짜를 실제 YYYY-MM-DD 날짜로 확인해 주세요.', 'discord_invalid_date');
  }
  return date;
}

function runIdValue(db, value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || !db.prepare('SELECT id FROM invoice_runs WHERE id = ?').get(value)) {
    throw failure('연결할 송장 작업을 확인해 주세요.', 'discord_invalid_run');
  }
  return value;
}

function record(row) {
  return { requestId: row.request_id, guildId: row.guild_id, channelId: row.channel_id, userId: row.user_id,
    action: row.action, status: row.status, runId: row.run_id, date: row.date,
    startedAt: row.started_at, finishedAt: row.finished_at };
}

function validateId(id) {
  if (typeof id !== 'string' || !snowflake.test(id)) throw failure('디스코드 요청 ID를 확인해 주세요.', 'discord_invalid_request');
}

export function claimDiscordRequest(db, body) {
  validateId(body.requestId);
  if (!actions.includes(body.action) || Object.keys(body).some(key => !['requestId', 'guildId', 'channelId', 'userId', 'action', 'runId', 'date'].includes(key))) {
    throw failure('지원하는 디스코드 업무 요청을 확인해 주세요.', 'discord_invalid_request');
  }
  const payload = { guildId: body.guildId, channelId: body.channelId, userId: body.userId, action: body.action,
    runId: runIdValue(db, body.runId), date: validateDate(body.date) };
  const inserted = db.prepare(`INSERT OR IGNORE INTO discord_requests
    (request_id, guild_id, channel_id, user_id, action, payload_json, run_id, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(body.requestId, body.guildId, body.channelId, body.userId, body.action, JSON.stringify(payload), payload.runId, payload.date);
  const row = db.prepare('SELECT * FROM discord_requests WHERE request_id = ?').get(body.requestId);
  if (row.payload_json !== JSON.stringify(payload)) throw failure('같은 요청 ID의 내용이 이전 요청과 다릅니다.', 'discord_request_mismatch', 409);
  if (!inserted.changes && ['running', 'interrupted'].includes(row.status)) {
    throw failure(row.status === 'running' ? '이 요청을 이미 처리 중입니다.' : '서버 재시작으로 중단된 요청입니다. 현재 작업을 확인한 뒤 새 요청으로 진행해 주세요.',
      row.status === 'running' ? 'discord_request_running' : 'discord_request_interrupted', 409, record(row));
  }
  return { created: Boolean(inserted.changes), request: record(row) };
}

export function finishDiscordRequest(db, requestId, body) {
  validateId(requestId);
  const row = db.prepare('SELECT * FROM discord_requests WHERE request_id = ?').get(requestId);
  if (!row || ['guildId', 'channelId', 'userId'].some((key, index) => body[key] !== [row.guild_id, row.channel_id, row.user_id][index])) {
    throw failure('이 범위의 디스코드 요청을 찾을 수 없습니다.', 'discord_request_missing', 404);
  }
  if (!['succeeded', 'failed'].includes(body.status)
    || Object.keys(body).some(key => !['guildId', 'channelId', 'userId', 'status', 'runId', 'date'].includes(key))) {
    throw failure('요청 처리 결과를 확인해 주세요.', 'discord_invalid_result');
  }
  const runId = body.runId === undefined ? row.run_id : runIdValue(db, body.runId);
  const date = body.date === undefined ? row.date : validateDate(body.date);
  if (row.status !== 'running') {
    if (row.status !== body.status || row.run_id !== runId || row.date !== date) {
      throw failure('이미 종료되거나 중단된 요청의 결과를 변경할 수 없습니다.', 'discord_request_finished', 409);
    }
    return record(row);
  }
  db.prepare(`UPDATE discord_requests SET status = ?, run_id = ?, date = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE request_id = ? AND status = 'running'`).run(body.status, runId, date, requestId);
  return record(db.prepare('SELECT * FROM discord_requests WHERE request_id = ?').get(requestId));
}

export function discordContext(db, { guildId, channelId }) {
  const row = db.prepare(`SELECT run_id AS runId, date FROM discord_requests WHERE guild_id = ? AND channel_id = ?
    AND status = 'succeeded' AND action IN ('create_invoice', 'replace_invoice', 'download_file', 'rebuild_file', 'review_tracking', 'select_tracking', 'replace_tracking', 'invoice_agent') AND run_id IS NOT NULL
    ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get(guildId, channelId);
  return row ? { ...row } : { runId: null, date: null };
}

function workflowState(db, runId) {
  if (runId === undefined || runId === null) return null;
  const view = invoiceView(db, runIdValue(db, runId)), summary = view.currentSummary || view.summary;
  const selectionRequired = view.trackingReview?.pendingCount || 0;
  const replacementAvailable = view.trackingReview?.replacementCount || 0;
  const included = view.items.filter(item => item.decision === 'include');
  const unresolved = view.issues.filter(value => value.reviewRequired && (!value.resolved
    || included.some(item => item.blockingIssueKeys?.includes(value.key))));
  const allowedNextActions = ['show_status', 'check_registration'];
  if (selectionRequired) allowedNextActions.push('review_tracking');
  if (replacementAvailable) allowedNextActions.push('replace_invoice');
  if (view.run.savedFileAvailable) allowedNextActions.push('download_file');
  if (!selectionRequired && included.length && !unresolved.length
    && !included.some(item => item.registrationState === 'conflict')) allowedNextActions.push('rebuild_file');
  return { runId: view.run.id, date: view.run.sourceDate, version: view.viewVersion,
    total: summary.total || 0, ready: summary.ready ?? summary.connected ?? 0, complete: summary.complete || 0,
    held: summary.hold ?? summary.held ?? 0, selectionRequired, replacementAvailable,
    savedFileAvailable: Boolean(view.run.savedFileAvailable),
    issues: [...new Set(unresolved.map(value => value.kind))],
    allowedNextActions };
}

export async function interpretDiscordRequest(db, body, client, model) {
  if (body.requestId !== undefined) validateId(body.requestId);
  if (Object.keys(body).some(key => !['requestId', 'guildId', 'channelId', 'userId', 'text', 'date', 'hasAttachments', 'runId'].includes(key))
    || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000 || typeof body.hasAttachments !== 'boolean') {
    throw failure('해석할 업무 요청을 4,000자 이내로 입력해 주세요.', 'discord_invalid_text');
  }
  const date = validateDate(body.date);
  if (!date) throw failure('요청 기준 날짜를 확인해 주세요.', 'discord_invalid_date');
  if (!client) throw failure('자연어 해석을 사용할 수 없습니다. 고정 명령을 사용하거나 AI 설정을 확인해 주세요.', 'discord_ai_unavailable');
  const workflow = workflowState(db, body.runId);
  try {
    return await callLlm(db, { purposeCode: 'discord_requests', itemCount: 1 }, client, {
      model, store: false, max_output_tokens: 600,
      instructions: guide + '\n\n출력은 action, date, message만 반환한다. action은 허용 목록에 있는 업무 의도다. message는 600자 이내 문자열 또는 null이다. 외부 도구나 작업을 실행하지 않는다.',
      input: JSON.stringify({ text: body.text.trim(), date, hasAttachments: body.hasAttachments, workflow }),
      text: { format: { type: 'json_schema', name: 'discord_invoice_request', strict: true, schema: {
        type: 'object', additionalProperties: false, required: ['action', 'date', 'message'], properties: {
          action: { type: 'string', enum: intentActions }, date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          message: { anyOf: [{ type: 'string', maxLength: 600 }, { type: 'null' }] },
        },
      } } },
    }, response => {
      if (response.status === 'incomplete' || response.error || response.output?.some(item => item.content?.some(value => value.type === 'refusal'))) throw new Error('incomplete_response');
      const value = JSON.parse(response.output_text);
      if (!value || !Object.hasOwn(value, 'date') || Object.keys(value).some(key => !['action', 'date', 'message'].includes(key))
        || !intentActions.includes(value.action) || (value.message !== undefined && value.message !== null
          && (typeof value.message !== 'string' || value.message.length > 600 || /\0/.test(value.message)))) throw new Error('invalid_action');
      return { action: value.action, date: validateDate(value.date), ...(value.message?.trim() ? { message: value.message.trim() } : {}) };
    });
  } catch {
    throw failure('요청을 해석하지 못했습니다. 고정 명령으로 다시 시도해 주세요.', 'discord_interpret_failed');
  }
}
