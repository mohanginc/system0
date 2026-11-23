import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const dayMs = 24 * 60 * 60 * 1000;
const koreaOffsetMs = 9 * 60 * 60 * 1000;
const retentionDays = 30;
const maxLineBytes = 16 * 1024;
const hidden = '[가림]';
const omitted = '[생략]';
const posixPermissions = process.platform !== 'win32';
const koreaDay = now => new Date(now + koreaOffsetMs).toISOString().slice(0, 10);
const traceFile = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const secretFields = new Set(['headers', 'body', 'requestbody', 'responsebody', 'raw', 'rawbody', 'buffer', 'bytes',
  'attachment', 'url', 'attachmenturl', 'downloadurl', 'proxyurl', 'internalkey', 'xsystem0discordkey',
  'recipient', 'recipientname', 'recipientphone', 'recipientaddress', 'buyer', 'buyername', 'receiver',
  'customer', 'customername', 'address', 'detailaddress', 'email', 'phone', 'phonenumber']);

function secretField(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return secretFields.has(normalized) || /(?:password|passwd|passphrase|secret|token|apikey|authorization|cookie|phone|address|email)$/.test(normalized)
    || /비밀번호|비번|암호|전화번호|연락처|수취인|주소/.test(key);
}

export function redactDiscordCredentials(text, secrets = []) {
  if (typeof text !== 'string') return '';
  const configured = Array.isArray(secrets) ? secrets.filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length) : [];
  for (const secret of configured) {
    text = /^\d+$/.test(secret) ? text.replace(new RegExp(`(?<!\\d)${secret}(?!\\d)`, 'g'), hidden) : text.split(secret).join(hidden);
  }
  return text
    .replace(/https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/(?:ephemeral-)?attachments\/[^\s<>]+/gi, '[첨부 링크]')
    .replace(/https?:\/\/(?:[a-z0-9.-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/[^\s<>]+/gi, '[웹훅 링크]')
    .replace(/((?:\b(?:proxy-)?authorization|\bx-system0-discord-key)["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|bot)\s+)?[^\s,;<>"']+/gi, '$1' + hidden)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer ' + hidden)
    .replace(/([?&](?:password|pwd|secret|token|api[_-]?key|signature|sig)=)[^\s&#<>]+/gi, '$1' + hidden)
    .replace(/((?:비밀번호|비번|암호|패스워드|토큰)["']?(?:\s*(?:는|은|가|이)\s*[:=]?\s*|\s*[:=]\s*|\s+|(?=\d))(?:(?:알려\s*(?:줄게요?|드릴게요?)|말해\s*(?:줄게요?|드릴게요?)|입력할게요?)\s*[:=]?\s*)?|\b(?:password|passwd|passphrase|pwd|[A-Z0-9_]*_PASSWORD|[A-Z0-9_]*_TOKEN|[A-Z0-9_]*_API_KEY|[A-Z0-9_]*_SECRET)\b["']?(?:\s+is\s+|\s*[:=]\s*|\s+)|\b(?:token|secret|api[ _-]?key)\b["']?\s*[:=]\s*)(?:"[^"\r\n]+"|'[^'\r\n]+'|\x60[^\x60\r\n]+\x60|[^\s<>"'\x60]+)/gi, '$1' + hidden)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|xox[bpars]-[A-Za-z0-9-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|mfa\.[A-Za-z0-9_-]{18,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{4,8}\.[A-Za-z0-9_-]{20,})\b/g, hidden);
}

export function redactDiscordText(text, secrets = []) {
  return redactDiscordCredentials(text, secrets)
    .replace(/^\s*\x60?\d{4,8}\x60?\s*$/, hidden)
    .replace(/((?:수취인(?:명)?|받는\s*분|배송지|(?:상세\s*)?주소)\s*[:=]\s*)[^,;\r\n]+/g, '$1' + hidden)
    .replace(/(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, hidden)
    .replace(/(?<!\d)(?:\+82[ .-]?(?:0)?|0)(?:1[016789]|2|[3-6]\d|70|50\d)[ .-]?[0-9*]{3,4}[ .-]?[0-9*]{4}(?!\d)/g, hidden);
}

export function discordTraceDirectory(env = process.env) {
  const state = env.STATE_DIRECTORY?.trim();
  if (state) return path.join(/^[A-Za-z]:[\\/]/.test(state) ? state : state.split(':')[0], 'discord-trace');
  const base = env.LOCALAPPDATA || env.XDG_STATE_HOME || (posixPermissions
    ? path.join(homedir(), '.local', 'state') : path.join(homedir(), 'AppData', 'Local'));
  return path.join(base, 'system0', 'discord-trace');
}

function redactedEvent(event, secrets) {
  let remaining = 150;
  function clean(value, depth) {
    if (typeof value === 'string') return redactDiscordText(value, secrets).slice(0, 1800);
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return omitted;
    if (depth >= 5) return omitted;
    if (Array.isArray(value)) return value.slice(0, 24).map(entry => remaining-- > 0 ? clean(entry, depth + 1) : omitted);
    const fields = Object.create(null);
    for (const key of Object.keys(value).slice(0, 32)) {
      if (value[key] === undefined) continue;
      if (--remaining < 0) break;
      const label = redactDiscordText(key, secrets).slice(0, 80);
      fields[label] = secretField(key) ? hidden : clean(value[key], depth + 1);
    }
    return fields;
  }
  return clean(event, 0);
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const settings = lstatSync(directory);
  if (!settings.isDirectory() || (posixPermissions && (settings.mode & 0o077))) throw new Error('discord_trace_directory_not_private');
}

function appendLine(filename, line) {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    | (posixPermissions ? (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0) : 0);
  const file = openSync(filename, flags, 0o600);
  try {
    const settings = fstatSync(file);
    if (!settings.isFile() || settings.nlink > 1) throw new Error('discord_trace_file_not_private');
    if (posixPermissions && (settings.mode & 0o077)) fchmodSync(file, 0o600);
    appendFileSync(file, line, 'utf8');
  } finally {
    closeSync(file);
  }
}

export function createDiscordTrace({ directory = discordTraceDirectory(), secrets = [],
  onError = error => console.warn('system0 디스코드 진단 로그를 저장하지 못했습니다.', error.code || error.name) } = {}) {
  const configured = Array.isArray(secrets) ? [...secrets] : [];
  let lastPrunedDay, unreported = true;
  return event => {
    try {
      if (!directory || typeof event?.stage !== 'string' || !event.stage.trim()) return;
      const now = Date.now(), day = koreaDay(now), timestamp = new Date(now).toISOString();
      const stage = redactDiscordText(event.stage, configured).slice(0, 100);
      const requestId = typeof event.requestId === 'string' ? redactDiscordText(event.requestId, configured).slice(0, 100) : undefined;
      const identity = { schema: 1, timestamp, stage, requestId };
      let line = JSON.stringify({ ...redactedEvent(event, configured), ...identity }) + '\n';
      if (Buffer.byteLength(line) > maxLineBytes) line = JSON.stringify({ ...identity, truncated: true }) + '\n';
      privateDirectory(directory);
      appendLine(path.join(directory, day + '.jsonl'), line);
      if (lastPrunedDay !== day) {
        lastPrunedDay = day;
        const oldest = koreaDay(now - (retentionDays - 1) * dayMs);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const date = entry.name.match(traceFile)?.[1];
          if (entry.isFile() && date && date < oldest) unlinkSync(path.join(directory, entry.name));
        }
      }
      unreported = true;
    } catch (error) {
      if (unreported) {
        unreported = false;
        try { onError(error); } catch { /* 진단 로그 오류는 업무 처리를 중단하지 않습니다. */ }
      }
    }
  };
}
