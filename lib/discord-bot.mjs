import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { discordScopeAllowed } from './discord-config.mjs';
import { invoiceConversationPending, runDiscordAgent } from './discord-invoice-agent.mjs';
import { invoiceAttachmentName, invoiceLinkLabel, invoiceTextReferences, renderInvoiceReferences } from './discord-invoice-links.mjs';

const maxFileSize = 10 * 1024 * 1024;
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const help = '네이버·로젠 파일을 함께 첨부하고 @system0 에게 요청하세요. 복수 송장은 채팅에서 교체·분할을 선택합니다.\n정정할 때는 “이번 파일의 송장으로 교체해줘”라고 요청하세요.';
const signature = (secret, scope, action, runId, date) => createHmac('sha256', secret)
  .update(JSON.stringify([scope.guildId, scope.channelId, action, runId, date])).digest('hex').slice(0, 24);

function addInvoiceRecipients(text, recipients) {
  if (!recipients.size) return text;
  const shown = new Set();
  // Annotate visible number tokens, leaving links, file names, and fenced code intact.
  return text.replace(/```[\s\S]*?(?:```|$)|https?:\/\/[^\s<>]+|`([\w-]{10,36})`|(?<![\w/.-])([\w-]{10,36})(?![\w-]|\.[A-Za-z0-9])/g,
    (token, code, plain, offset) => {
      const id = code || plain, name = recipients.get(id);
      if (!name || shown.has(id)) return token;
      shown.add(id);
      const before = text.slice(Math.max(0, offset - name.length - 6), offset).trimEnd().replace(/[(·:–-]$/, '').trimEnd();
      const after = text.slice(offset + token.length).trimStart();
      if (before.endsWith(name) || after.startsWith(`(${name})`) || after.startsWith(`· ${name}`)) return token;
      const escaped = name.replace(/[\\`*_{}\[\]()#+.!|<>~]/g, '\\$&');
      return `${escaped} (${token})`;
    });
}

export function discordAttachment(file) {
  const extension = typeof file.name === 'string' && !/[\r\n\0/\\]/.test(file.name) ? /\.xlsx?$/i.exec(file.name)?.[0] : null;
  const title = typeof file.title === 'string' ? file.title : '';
  const name = extension && title ? title.toLowerCase().endsWith(extension.toLowerCase()) ? title : title + extension : file.name;
  return { name, size: file.size, url: file.url };
}

export function discordButtonId(config, scope, action, runId, date) {
  return `s0:${action}:${runId}:${date}:${signature(config.secret, scope, action, runId, date)}`;
}

export function parseDiscordButton(config, scope, value) {
  const match = /^s0:(download_file|show_status|check_registration):([1-9]\d*):(\d{4}-\d{2}-\d{2}):([a-f0-9]{24})$/.exec(value || '');
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('작업 버튼을 확인해 주세요.');
  const [, action, id, date, signed] = match, runId = Number(id);
  if (!timingSafeEqual(Buffer.from(signed), Buffer.from(signature(config.secret, scope, action, runId, date)))) {
    throw new Error('이 채널에서 사용할 수 없는 작업 버튼입니다.');
  }
  return { action, runId, date };
}

const reviewActions = { r: 'replace_tracking', s: 'select_tracking', b: 'rebuild_file', v: 'review_tracking',
  t: 'stage_tracking', p: 'tracking_page', a: 'apply_tracking' };
const trackingFormActions = new Set(['stage_tracking', 'tracking_page', 'apply_tracking']);
const menusPerPage = 4;
const draftLifetime = 60 * 60 * 1000;

// Registration refreshes can change viewVersion without changing any tracking candidate.
function trackingVersion(detail, groupKeys = null) {
  const groups = (detail.trackingReview?.groups || []).filter(group => !groupKeys || groupKeys.includes(group.key));
  const itemIds = new Set(groups.flatMap(group => group.itemIds || []));
  const decisions = (detail.items || []).filter(item => itemIds.has(item.id)).map(({ id, decision, note }) => [id, decision, note]);
  return createHash('sha256').update(JSON.stringify([detail.scopeRequired, detail.rematchRequired, groups, decisions, groupKeys])).digest('hex');
}
function reviewSignature(config, scope, value) {
  return createHmac('sha256', config.secret).update(JSON.stringify([scope.guildId, scope.channelId, scope.userId, value])).digest('hex').slice(0, 20);
}
function reviewButton(config, scope, action, detail, date, index = 0, reviewScope = null) {
  const code = Object.keys(reviewActions).find(key => reviewActions[key] === action);
  const version = trackingFormActions.has(action) ? trackingVersion(detail, reviewScope?.groupKeys) : detail.viewVersion;
  const value = `s0r:${code}:${detail.run.id}:${date}:${version.slice(0, 20)}:${index}${reviewScope ? ':' + reviewScope.id : ''}`;
  return `${value}:${reviewSignature(config, scope, value)}`;
}
function parseReviewButton(config, scope, value) {
  const match = /^(s0r:([rsbvtpa]):([1-9]\d*):(\d{4}-\d{2}-\d{2}):([a-f0-9]{20}):(\d{1,6})(?::([a-f0-9]{12}))?):([a-f0-9]{20})$/.exec(value || '');
  if (!match || !Number.isSafeInteger(Number(match[3]))
    || !timingSafeEqual(Buffer.from(match[8]), Buffer.from(reviewSignature(config, scope, match[1])))) {
    throw new Error('이 계정과 채널에서 사용할 수 없는 선택 버튼입니다. 최신 상태에서 다시 선택해 주세요.');
  }
  return { action: reviewActions[match[2]], runId: Number(match[3]), date: match[4], version: match[5], index: Number(match[6]), scopeId: match[7] || null };
}

export function updatesDiscordTrackingForm(config, scope, buttonId) {
  if (!/^s0r:[tpa]:/.test(buttonId || '')) return false;
  try { return trackingFormActions.has(parseReviewButton(config, scope, buttonId).action); }
  catch { return false; }
}

export async function readDiscordBytes(response, limit = maxFileSize) {
  if (!response.ok) throw new Error(`파일을 읽지 못했습니다. HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) throw new Error('파일 하나는 10MB까지 사용할 수 있습니다.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('파일 내용이 없습니다.');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error('파일 하나는 10MB까지 사용할 수 있습니다.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!total) throw new Error('빈 파일은 사용할 수 없습니다.');
  return Buffer.concat(chunks, total);
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw new Error('처리일은 YYYY-MM-DD 형식의 실제 날짜로 지정해 주세요.');
  return value;
}

const traceCountFields = ['total', 'rows', 'connected', 'ready', 'complete', 'pending', 'attention', 'hold', 'conflict', 'excluded',
  'unknown', 'missingSaved', 'canceled', 'returned', 'succeeded', 'failed', 'skipped'];
const traceFile = ({ name, size, attachment }) => ({ name: typeof name === 'string' ? name.split(/[/\\]/).at(-1) : undefined,
  sizeBytes: attachment?.byteLength ?? size });

function traceApiParameters(route, options) {
  const body = options.body;
  if (body instanceof FormData) return { date: body.get('sourceDate'), files: body.getAll('files').length,
    naverFiles: body.getAll('naverFiles').length, courierFiles: body.getAll('courierFiles').length,
    naverDecryptionConfigured: body.has('naverPassword') };
  const date = new URLSearchParams(route.split('?')[1]).get('date');
  if (typeof body !== 'string' || body.length > 8192 || /^\/api\/discord\/(agent-step|conversation\/)/.test(route)) return date ? { date } : undefined;
  let data;
  try { data = JSON.parse(body); } catch { return undefined; }
  if (!data || typeof data !== 'object') return undefined;
  const fields = ['action', 'date', 'runId', 'mode', 'validateOnly', 'status'];
  const parameters = Object.fromEntries(fields.filter(key => ['string', 'boolean', 'number'].includes(typeof data[key])).map(key => [key, data[key]]));
  if (/^\/api\/invoices\/\d+\/tracking$/.test(route) && Array.isArray(data.choices)) parameters.choicesCount = data.choices.length;
  if (Array.isArray(data.resolutions)) parameters.resolutionsCount = data.resolutions.length;
  if (Array.isArray(data.productOrderIds)) parameters.productOrdersCount = data.productOrderIds.length;
  return parameters;
}

function traceApiResult(data) {
  if (data?.attachment) return traceFile(data);
  const detail = data?.invoice || data;
  const result = {};
  if (detail?.request) {
    const { action, status, runId, date } = detail.request;
    result.request = { action, status, runId, date };
  }
  if (detail?.run?.id || detail?.runId) result.runId = detail.run?.id || detail.runId;
  if (detail?.run?.sourceDate || detail?.date) result.date = detail.run?.sourceDate || detail.date;
  if (detail?.batch?.id) result.batchId = detail.batch.id;
  if (typeof detail?.status === 'string') result.status = detail.status;
  if (typeof detail?.action === 'string') result.action = detail.action;
  if (typeof detail?.valid === 'boolean') result.valid = detail.valid;
  if (Array.isArray(detail?.turns)) result.historyTurns = detail.turns.length;
  if (Array.isArray(detail?.runIds)) result.runIds = detail.runIds.slice(0, 20);
  if (Array.isArray(detail?.invoiceRuns)) result.invoiceRunIds = detail.invoiceRuns.map(run => run.id).slice(0, 20);
  if (Array.isArray(detail?.items)) result.items = detail.items.length;
  if (Array.isArray(detail?.issues)) result.warnings = detail.issues.length;
  if (Array.isArray(detail?.included)) result.included = detail.included.length;
  if (Array.isArray(detail?.skipped)) result.skipped = detail.skipped.length;
  if (detail?.trackingReview) result.pendingSelections = detail.trackingReview.pendingCount;
  if (detail?.fileActions) result.fileActions = { create: detail.fileActions.create, saved: detail.fileActions.saved,
    reviewRequired: detail.fileActions.reviewRequired, reason: detail.fileActions.reason };
  const summary = detail?.currentSummary || detail?.summary;
  if (summary) result.counts = Object.fromEntries(traceCountFields.filter(key => Number.isFinite(summary[key])).map(key => [key, summary[key]]));
  if (Array.isArray(detail?.errors)) result.errors = detail.errors.slice(0, 10).map(({ runId, kind, error }) => ({ runId, kind, error }));
  if (Array.isArray(detail?.output)) result.tools = detail.output.filter(entry => entry.type === 'function_call').map(entry => entry.name).slice(0, 10);
  return result;
}

export function createDiscordHandler({ config, fetcher = fetch, trace }) {
  const pending = new Set(), channels = new Set(), trackingDrafts = new Map(), trackingScopes = new Map();
  async function requestApi(route, { binary = false, fallbackName = '네이버_발송처리.xlsx', ...options } = {}, log, sequence) {
    const started = Date.now(), method = options.method || 'GET', endpoint = route.split('?')[0];
    const context = { sequence, method, endpoint };
    log(() => ({ stage: 'api.start', ...context, parameters: traceApiParameters(route, options) }));
    let response;
    try {
      response = await fetcher(config.baseUrl + route, { signal: AbortSignal.timeout(300000), ...options,
        headers: { 'X-System0-Discord-Key': config.secret, ...options.headers } });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const error = new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : `system0 요청 실패: HTTP ${response.status}`);
        error.status = response.status; error.code = data.code; throw error;
      }
      let data;
      if (binary) {
        const disposition = response.headers.get('content-disposition') || '';
        const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        const plain = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
        const filename = encoded ? decodeURIComponent(encoded[1]) : plain ? (plain[1] || plain[2]).trim() : fallbackName;
        data = { attachment: await readDiscordBytes(response), name: filename.replace(/[/\\\r\n\0]/g, '_') };
      } else data = await response.json();
      log(() => ({ stage: 'api.result', ...context, status: response.status, elapsedMs: Date.now() - started, outcome: 'ok', result: traceApiResult(data) }));
      return data;
    } catch (error) {
      log({ stage: 'api.result', ...context, status: response?.status, elapsedMs: Date.now() - started,
        outcome: 'error', code: error.code, error: error.message });
      throw error;
    }
  }
  async function attachmentForm(attachments, log) {
    const form = new FormData();
    let total = 0;
    for (const file of attachments) {
      const started = Date.now();
      let response;
      log(() => ({ stage: 'attachment.start', ...traceFile(file) }));
      try {
        const url = new URL(file.url);
        if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
          || !url.pathname.startsWith('/attachments/') || url.username || url.password || url.port) throw new Error('디스코드에 직접 첨부한 파일만 사용할 수 있습니다.');
        if (!/\.xlsx?$/i.test(file.name) || /[\r\n\0/\\]/.test(file.name)) throw new Error('.xls 또는 .xlsx 파일만 사용할 수 있습니다.');
        if (file.size > maxFileSize) throw new Error('파일 하나는 10MB까지 사용할 수 있습니다.');
        response = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(60000) });
        const data = await readDiscordBytes(response);
        total += data.length;
        if (total > 50 * 1024 * 1024) throw new Error('한 번에 업로드하는 파일의 합계는 50MB까지 가능합니다.');
        form.append('files', new Blob([data]), file.name);
        log({ stage: 'attachment.result', name: file.name, sizeBytes: data.length, status: response.status, elapsedMs: Date.now() - started, outcome: 'ok' });
      } catch (error) {
        log({ stage: 'attachment.result', ...traceFile(file), status: response?.status, elapsedMs: Date.now() - started,
          outcome: 'error', code: error.code, error: error.message });
        throw error;
      }
    }
    return form;
  }
  function importInvoiceFiles(api, form, date) {
    form.set('deliveryCompanyCode', 'KGB');
    form.set('sourceDate', validateDate(date));
    if (config.naverPassword) form.set('naverPassword', config.naverPassword);
    return api('/api/invoices/import', { method: 'POST', body: form });
  }
  function invoiceRunUrl(runId) {
    const url = new URL('/invoices.html', config.publicOrigin);
    url.searchParams.set('run', runId);
    return url.href;
  }
  function invoicePresenter(api, scope) {
    const known = new Set(), metadata = new Map(), requested = new Set();
    const remember = ids => ids.filter(id => Number.isSafeInteger(id) && id > 0).forEach(id => known.add(id));
    const load = async ids => {
      const missing = [...new Set(ids)].filter(id => known.has(id) && !requested.has(id)).slice(0, 50);
      if (!missing.length) return;
      missing.forEach(id => requested.add(id));
      const query = new URLSearchParams({ ...scope, invoiceIds: JSON.stringify(missing) });
      const result = await api('/api/discord/context?' + query).catch(() => null);
      for (const run of result?.invoiceRuns || []) if (missing.includes(run.id)) metadata.set(run.id, run);
    };
    const text = async (content, limit) => {
      await load(invoiceTextReferences(content, known));
      return renderInvoiceReferences(content, known, metadata, invoiceRunUrl, limit);
    };
    const link = id => known.has(id) ? `[${invoiceLinkLabel(metadata.get(id))}](${invoiceRunUrl(id)})` : null;
    return { remember, load, text, link, output: async value => {
      if (!value) return value;
      const content = value.content || '';
      await load(invoiceTextReferences([content, ...(value.files || []).map(file => file.name)].join('\n'), known));
      return { ...value, ...(value.content ? { content: renderInvoiceReferences(content, known, metadata, invoiceRunUrl) } : {}),
        ...(value.files ? { files: value.files.map(file => ({ ...file, name: invoiceAttachmentName(file.name, metadata) })) } : {}) };
    } };
  }
  async function workLinks(targets, presenter) {
    const pages = { invoices: '/invoices.html', orders: '/product-names', intake: '/', packing: '/#packing', shipping: '/shipping-board.html',
      products: '/products.html', usage: '/llm-usage.html', 'logen-export': '/api/shipping/logen-export' };
    await presenter.load(targets.filter(target => target.page === 'invoices').map(target => target.runId));
    const links = targets.map(({ page, runId, batchId, date }) => {
      if (!Object.hasOwn(pages, page)) return null;
      if (page === 'invoices' && runId) return presenter.link(runId);
      const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(date || '');
      if (page === 'logen-export' && !hasDate) return null;
      const link = new URL(page === 'orders' && batchId ? '/' : pages[page], config.publicOrigin);
      if (batchId) link.searchParams.set('batch', batchId);
      if ((page === 'shipping' || page === 'logen-export') && hasDate) link.searchParams.set('date', date);
      const label = page === 'logen-export' ? '로젠 등록 파일 받기' : '웹에서 작업 열기';
      return `[${label}](${link.href})${batchId ? ' · #' + batchId : ''}`;
    }).filter(Boolean);
    return [...new Set(links)].slice(0, 3).join('\n');
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const needsReview = detail => !detail || Boolean(detail.fileActions?.reviewRequired || detail.trackingReview?.pendingCount);
  function buttons(scope, runId, date, detail, withFile = true) {
    const reviewing = needsReview(detail), components = [
      { type: 2, style: 5, label: reviewing ? 'system0에서 검토' : 'system0에서 보기', url: invoiceRunUrl(runId) },
    ];
    if (withFile && !reviewing && (detail.fileActions?.create || detail.fileActions?.rebuild || detail.run.savedFileAvailable)) {
      components.push({ type: 2, style: 1, label: detail.run.savedFileAvailable ? '보관 엑셀 받기' : '엑셀 만들기',
        custom_id: discordButtonId(config, scope, 'download_file', runId, date) });
    }
    if (reviewing) components.push({ type: 2, style: 2, label: '검토 결과 확인',
      custom_id: discordButtonId(config, scope, 'show_status', runId, date) });
    const items = detail?.items || [], registrationConflict = items.some(item => item.registrationState === 'conflict' || item.registrationRecheck);
    const fullyRegistered = detail?.currentSummary?.total > 0 && detail.currentSummary.complete === detail.currentSummary.total;
    if (detail && !fullyRegistered && !detail.scopeRequired && !detail.rematchRequired && (registrationConflict || !reviewing
      && items.some(item => !item.superseded && (!item.statusFresh || item.registrationState !== 'complete')))) {
      components.push({ type: 2, style: 2, label: '네이버 등록 확인',
        custom_id: discordButtonId(config, scope, 'check_registration', runId, date) });
    }
    if (detail?.trackingReview?.groups.some(group => group.mode === 'split' && group.splitEligible !== false
      || group.kind === 'assignment' && group.mode === 'assign' && group.assignEligible)) {
      components.push({ type: 2, style: 2, label: '송장 선택 수정', custom_id: reviewButton(config, scope, 'review_tracking', detail, date) });
    }
    return [{ type: 1, components }];
  }
  function summary(detail) {
    const s = detail.currentSummary || detail.summary;
    return `송장 작업 #${detail.run.id}\n상품주문 ${s.total || 0}건 · 등록 확인 ${s.complete || 0}건 · 송장 찾음 ${s.ready ?? s.connected ?? 0}건 · 확인 필요 ${(s.unknown || 0) + (s.attention || 0) + (s.hold || 0) + (s.missingSaved || 0)}건`;
  }
  function getFile(api, detail, mode = 'auto') {
    return api(`/api/invoices/${detail.run.id}/file`, { ...json('POST', { mode, expectedVersion: detail.viewVersion }), binary: true });
  }
  function trackingRowsText(rows) {
    return rows.map(row => {
      const ids = row.productOrderIds || [], listed = ids.slice(0, 2).join(', ');
      const product = listed + (ids.length > 2 ? ` 외 ${ids.length - 2}건` : '');
      const applied = row.currentTrackingNumber && row.currentTrackingNumber !== row.reprintTrackingNumber
        ? ` · 현재 적용 \`${row.currentTrackingNumber}\`` : '';
      return `${row.position}. ${product || row.internalId} · 이번 파일 \`${row.reprintTrackingNumber}\` · 원송장 \`${row.originalTrackingNumber}\`${applied}`;
    }).join('\n');
  }
  function reviewEntries(review, groupKeys = null) {
    const entries = [];
    const groups = review.groups.filter(group => !groupKeys || groupKeys.includes(group.key));
    for (const [index, group] of groups.entries()) {
      if (!groupKeys && !(review.pendingCount ? group.needsSelection : group.mode === 'split' && group.splitEligible !== false
        || group.kind === 'assignment' && group.mode === 'assign' && group.assignEligible)) continue;
      const assignment = group.kind === 'assignment';
      const reference = group.kind === 'reprint_reference';
      const identity = assignment ? `상품주문 ${group.productOrderIds.join(' · ')} · ${group.optionName || group.productName || ''}`
        : reference ? `상품주문 ${group.productOrderIds.join(' · ')}` : `출고 ${group.internalId || '번호 없음'}`;
      const numbers = reference ? `\n이번 파일 ${group.reprintTrackingNumber} · 원송장 ${group.originalTrackingNumber}` : '';
      const description = `${group.recipient || '수취인 미확인'} · ${identity}${numbers}`.slice(0, 260);
      if (!group.candidates?.length || group.candidates.length > 12 || group.selectable === false || assignment && !group.assignEligible) continue;
      const options = reference ? group.candidates.filter(candidate => group.replaceEligible && candidate.selectable).map(candidate => ({
        label: `${candidate.referenceOnly ? '라벨을 확인한 원송장' : '재출력 송장'} · ${candidate.trackingNumber}`,
        value: `${candidate.referenceOnly ? 'original' : 'replace'}:${candidate.trackingNumber}`,
        default: group.mode === 'replace' && group.selectedTrackingNumber === candidate.trackingNumber,
        description: candidate.referenceOnly ? '실제 상자에 원송장을 붙였으면 선택하세요.' : '이번 로젠 파일의 번호를 적용합니다.',
      })) : group.candidates.filter(candidate => candidate.valid !== false && candidate.selectable !== false)
        .flatMap(candidate => (assignment ? ['assign'] : ['replace', 'split'])
        .filter(mode => mode === 'assign' || (mode === 'replace' ? group.replaceEligible !== false && candidate.currentFile !== false : group.splitEligible !== false)).map(mode => ({
        label: `${mode === 'assign' ? '분리 배송' : mode === 'replace' ? '교체' : '분할 대표'} · ${candidate.trackingNumber}`.slice(0, 100),
        value: `${mode}:${candidate.trackingNumber}`,
        default: group.selectedTrackingNumber === candidate.trackingNumber && group.mode === mode,
        description: [candidate.round != null ? `차수 ${candidate.round}` : '', candidate.printedAt || '',
          mode === 'assign' ? `출고 ${candidate.internalId}` : mode === 'replace' ? '다른 번호는 교체 이력으로 보관' : '실물 송장 모두 유지'].filter(Boolean).join(' · ').slice(0, 100),
      })));
      if (options.length) entries.push({ group, index, description, options,
        placeholder: `${assignment ? identity : group.recipient || group.internalId} 적용 송장 선택`.slice(0, 150) });
    }
    return entries;
  }
  function reviewOutput(scope, detail, date, { selections = new Map(), page = 0, showResolved = true, groupKeys = null, scopeId = null } = {}) {
    const review = detail.trackingReview || { groups: [], pendingCount: 0, replacementCount: 0 };
    let reviewScope = null;
    if (groupKeys) {
      const now = Date.now();
      for (const [id, saved] of trackingScopes) if (saved.expiresAt <= now) trackingScopes.delete(id);
      const id = scopeId || randomBytes(6).toString('hex');
      reviewScope = { id, groupKeys: [...new Set(groupKeys)] };
      trackingScopes.set(id, { ...reviewScope, ...scope, runId: detail.run.id, expiresAt: now + draftLifetime });
    }
    const selectedGroups = review.groups.filter(group => !groupKeys || groupKeys.includes(group.key));
    const pendingCount = selectedGroups.filter(group => group.needsSelection).length;
    const output = { content: summary(detail), components: [] };
    if (pendingCount) output.content += `\n송장 선택이 필요한 출고 ${pendingCount}건입니다.`;
    else if (detail.fileActions?.reviewRequired) output.content += '\n' + detail.fileActions.reason;
    const entries = showResolved || pendingCount ? reviewEntries(review, groupKeys) : [];
    const pageCount = Math.ceil(entries.length / menusPerPage);
    const actions = [];
    if (entries.length) {
      const start = page * menusPerPage;
      for (const entry of entries.slice(start, start + menusPerPage)) {
        const value = selections.get(entry.group.key);
        output.content += '\n' + entry.description;
        output.components.push({ type: 1, components: [{ type: 3,
          custom_id: reviewButton(config, scope, 'stage_tracking', detail, date, entry.index, reviewScope),
          placeholder: entry.placeholder, min_values: 1, max_values: 1,
          options: entry.options.map(option => value ? { ...option, default: option.value === value } : option) }] });
      }
      const selected = entries.filter(entry => selections.has(entry.group.key) || entry.options.some(option => option.default)).length;
      output.content += `\n선택 ${selected}/${entries.length}건${pageCount > 1 ? ` · ${page + 1}/${pageCount} 페이지` : ''}`;
      actions.push({ type: 2, style: 1, label: '선택 적용', disabled: selected !== entries.length || selections.size === 0,
        custom_id: reviewButton(config, scope, 'apply_tracking', detail, date, 0, reviewScope) });
      if (page > 0) actions.push({ type: 2, style: 2, label: '이전',
        custom_id: reviewButton(config, scope, 'tracking_page', detail, date, page - 1, reviewScope) });
      if (page + 1 < pageCount) actions.push({ type: 2, style: 2, label: '다음',
        custom_id: reviewButton(config, scope, 'tracking_page', detail, date, page + 1, reviewScope) });
    }
    if (pendingCount > entries.length) output.content += '\n선택할 수 없는 출고는 system0에서 검토해 주세요.';
    if (groupKeys && !selectedGroups.length) output.content += '\n요청한 출고를 찾지 못했습니다. 상품주문번호와 송장번호를 다시 확인해 주세요.';
    if (!groupKeys && review.replacementCount) {
      actions.push({ type: 2, style: 1, label: '이번 파일의 송장으로 교체', custom_id: reviewButton(config, scope, 'replace_tracking', detail, date) });
    }
    const referenceSelected = review.groups.some(group => group.kind === 'reprint_reference' && group.mode);
    if (!review.pendingCount && !detail.fileActions?.reviewRequired && (detail.fileActions?.create || !referenceSelected && detail.fileActions?.rebuild)) actions.push({ type: 2, style: 1, label: '선택 완료 · 엑셀 만들기',
      custom_id: reviewButton(config, scope, 'rebuild_file', detail, date) });
    const extra = buttons(scope, detail.run.id, date, detail, false)[0].components.filter(button => !groupKeys || button.label !== '송장 선택 수정');
    output.components.push({ type: 1, components: [...actions, ...extra].slice(0, 5) });
    return output;
  }
  function trackingForm(scope, detail, date, event, review) {
    const savedScope = review.scopeId && trackingScopes.get(review.scopeId);
    if (review.scopeId && (!savedScope || savedScope.expiresAt <= Date.now() || savedScope.runId !== detail.run.id
      || ['guildId', 'channelId', 'userId'].some(key => savedScope[key] !== scope[key]))) {
      throw new Error('선택 범위가 만료되었습니다. 변경할 상품주문이나 송장번호로 다시 요청해 주세요.');
    }
    const groupKeys = savedScope?.groupKeys || null;
    const options = { groupKeys, scopeId: review.scopeId };
    const refresh = note => {
      const output = reviewOutput(scope, detail, date, options);
      output.content = note + '\n' + output.content;
      return { output };
    };
    if (!trackingVersion(detail, groupKeys).startsWith(review.version)) return refresh('송장 후보 또는 검토 상태가 바뀌었습니다. 현재 목록을 확인해 주세요.');
    if (!/^\d{17,20}$/.test(event.sourceMessageId || '')) throw new Error('검토 결과를 다시 열고 송장을 선택해 주세요.');
    const now = Date.now();
    for (const [key, draft] of trackingDrafts) if (draft.expiresAt <= now) trackingDrafts.delete(key);
    const key = JSON.stringify([scope.guildId, scope.channelId, scope.userId, event.sourceMessageId, detail.run.id, review.version, review.scopeId]);
    const draft = trackingDrafts.get(key) || { selections: new Map(), page: 0 };
    const entries = reviewEntries(detail.trackingReview || { groups: [], pendingCount: 0 }, groupKeys);
    const { selections } = draft;
    if (review.action === 'stage_tracking') {
      const index = entries.findIndex(entry => entry.index === review.index);
      const entry = entries[index], value = event.values?.length === 1 && event.values[0];
      if (!entry?.options.some(option => option.value === value)) throw new Error('현재 목록에서 적용할 송장을 선택해 주세요.');
      selections.set(entry.group.key, value);
      draft.page = Math.floor(index / menusPerPage);
    } else if (review.action === 'tracking_page') {
      if (review.index >= Math.ceil(entries.length / menusPerPage)) return refresh('현재 송장 목록을 확인해 주세요.');
      draft.page = review.index;
    } else {
      if (!selections.size) return refresh('임시 선택이 없습니다. 적용할 송장을 선택해 주세요.');
      if (entries.some(entry => !selections.has(entry.group.key) && !entry.options.some(option => option.default))) {
        const output = reviewOutput(scope, detail, date, { ...options, selections, page: draft.page });
        output.content = '표시된 송장을 모두 선택해 주세요.\n' + output.content;
        return { output };
      }
      const choices = [], lines = [];
      for (const { group, options } of entries) {
        const value = selections.get(group.key);
        if (!value) continue;
        const option = options.find(option => option.value === value);
        const [mode, trackingNumber] = value.split(':');
        choices.push({ key: group.key, trackingNumber, mode: mode === 'original' ? 'replace' : mode,
          ...(mode === 'original' ? { acknowledgeOriginal: true } : {}) });
        lines.push(`- ${group.recipient || group.internalId || '출고'} · ${group.productOrderIds?.[0] || group.internalId || ''} · ${option.label}`);
      }
      const listed = [];
      let length = 0;
      for (const line of lines) {
        if (length + line.length > 1450) break;
        listed.push(line);
        length += line.length + 1;
      }
      const preview = listed.join('\n') + (listed.length < lines.length ? `\n외 ${lines.length - listed.length}건` : '');
      return { detail, choices, key, preview, ...options };
    }
    draft.expiresAt = now + draftLifetime;
    trackingDrafts.set(key, draft);
    return { output: reviewOutput(scope, detail, date, { ...options, selections, page: draft.page }) };
  }
  async function processRequest(event, { onProgress, onResult, api, presenter }, scope, log) {
    const channelKey = `${scope.guildId}/${scope.channelId}`;
    if (pending.has(event.id)) { log({ stage: 'request.skipped', reason: 'duplicate_inflight' }); return null; }
    if (channels.has(channelKey)) {
      log({ stage: 'request.skipped', reason: 'channel_busy' });
      return { content: '이 채널의 요청을 처리 중입니다. 완료 후 다시 요청해 주세요.' };
    }
    pending.add(event.id); channels.add(channelKey);
    let claimed = false, completed = false, runId;
    try {
      const userText = event.text || '';
      const useWorkHistory = Boolean(config.plainMessageChannelIds?.includes(scope.channelId));
      const conversation = event.kind === 'message' && event.botMessageId && userText.trim()
        ? await api('/api/discord/conversation/load', json('POST', { ...scope, replyToId: event.replyToId || null, text: userText,
          ...(useWorkHistory ? { useWorkHistory } : {}) }))
        : null;
      async function respond(output, { runIds = [], productOrderIds = [], pending = null, historyContent } = {}) {
        output = await presenter.output(output);
        if (!conversation || !output.content) return output;
        if (onResult) await onResult(output);
        try {
          await api('/api/discord/conversation/save', json('POST', { ...scope, messageId: event.id, botMessageId: event.botMessageId,
            conversationId: conversation.conversationId ?? null, userText, botText: historyContent ?? output.content,
            runIds: runIds.slice(0, 200), productOrderIds: productOrderIds.slice(0, 200), pending,
            ...(useWorkHistory ? { useWorkHistory } : {}) }));
        } catch (error) {
          console.warn('system0 디스코드 업무 대화를 저장하지 못했습니다.', error.code || error.status || error.name);
        }
        return output;
      }
      if (conversation?.status === 'ambiguous') {
        const choices = (conversation.runIds || []).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 6).map(id => `송장 작업 #${id}`);
        const content = choices.length === 1 ? `${choices[0]}에서 확인할 상품주문이 여러 건입니다. 상품주문번호와 요청을 적어 주세요.`
          : choices.length ? `이어갈 송장 작업이 여러 개입니다. ${choices.join(', ')}에서 해당 상품주문번호를 확인해 요청과 함께 적어 주세요.`
            : '이어갈 작업이 여러 개입니다. 상품주문번호와 요청을 적어 주세요.';
        return await respond({ content });
      }
      if (conversation?.status === 'expired') {
        return await respond({ content: '답장한 대화의 작업을 찾을 수 없습니다. 처리 날짜나 상품주문번호를 적어 새로 요청해 주세요.' });
      }
      function respondInvoice(output, detail, runIds = detail ? [detail.run.id] : [], rememberPending = false) {
        return respond(output, { runIds, productOrderIds: [...new Set((detail?.items || []).map(item => item.productOrderId).filter(Boolean))],
          pending: conversation && rememberPending && detail ? invoiceConversationPending(detail) : null });
      }
      let action = event.action, date = event.date, review, message;
      if (event.buttonId?.startsWith('s0r:')) {
        review = parseReviewButton(config, scope, event.buttonId);
        ({ action, runId, date } = review);
      } else if (event.buttonId) ({ action, runId, date } = parseDiscordButton(config, scope, event.buttonId));
      let form;
      if (trackingFormActions.has(action)) {
        if (!review) throw new Error('현재 작업의 선택 버튼을 사용해 주세요.');
        log({ stage: 'request.route', action, date, runId });
        const detail = await api(`/api/invoices/${runId}`);
        form = trackingForm(scope, detail, date, event, review);
        if (form.output) return form.output;
      }
      const context = form ? {} : await api('/api/discord/context?' + new URLSearchParams(scope));
      const attachments = event.attachments || [];
      if (!action && attachments.length && !useWorkHistory && conversation?.status !== 'matched') {
        ({ action, date, message } = await api('/api/discord/interpret', json('POST', { ...scope, text: event.text || '',
          date: today(), hasAttachments: true, runId: context.runId || null })));
      }
      if (!form) log({ stage: 'request.route', action: action || 'invoice_agent', date, runId, historyStatus: conversation?.status, useWorkHistory });
      if (!action || action === 'work_agent') {
        const agentDate = today();
        const { request } = await api('/api/discord/requests', json('POST', { ...scope, requestId: event.id, action: 'invoice_agent' }));
        if (request.status !== 'running') return { content: request.status === 'succeeded'
          ? '이미 처리한 요청입니다.' : '이전 요청의 결과를 확인한 뒤 새 요청으로 진행해 주세요.' };
        claimed = true;
        let attachmentsUsed = false;
        const claimAttachmentForm = async () => {
          if (attachmentsUsed) throw new Error('이 요청의 파일은 이미 처리했습니다. 다른 업무는 파일을 따로 첨부해 주세요.');
          const form = await attachmentForm(attachments, log);
          attachmentsUsed = true;
          return form;
        };
        const workContext = useWorkHistory ? null : context;
        const result = await runDiscordAgent({ api, json, scope, text: userText, today: agentDate, context: workContext, conversation,
          useWorkHistory: useWorkHistory && Boolean(conversation), onProgress, trace: log,
          attachments: attachments.map(({ name, size }) => ({ name, size })), attachmentForm: claimAttachmentForm,
          importInvoiceFiles: (form, date) => importInvoiceFiles(api, form, date) });
        runId = result.lastRun?.runId;
        log({ stage: 'request.workflow_result', outcome: result.outcome, runId });
        await api(`/api/discord/requests/${event.id}`, json('PATCH', { ...scope, status: 'succeeded',
          ...(runId ? { runId, date: result.lastRun.date || agentDate } : {}) }));
        completed = true;
        presenter.remember(result.invoiceRunIds);
        const review = result.review && await api('/api/invoices/' + result.review.runId).then(view =>
          reviewOutput(scope, view, view.run.sourceDate || agentDate, { groupKeys: result.review.groupKeys || null })).catch(() => null);
        const rows = result.review?.trackingRows || [];
        const choices = rows.length ? `**${rows.some(row => row.needsSelection) ? '송장 선택 후보' : '송장 적용 내역'}**\n${trackingRowsText(rows)}` : '';
        const links = await workLinks(result.webTargets, presenter);
        const replyText = async (bodyText, choiceText) => {
          const tail = [choiceText, links].filter(Boolean).join('\n\n');
          const limit = tail ? Math.max(0, 1998 - tail.length) : 2000;
          const body = await presenter.text(bodyText, limit);
          const additionalLinks = links.split('\n').filter(link => link && !body.includes(link)).join('\n');
          return [body, choiceText, additionalLinks].filter(Boolean).join('\n\n');
        };
        const historyContent = await replyText(result.content, choices);
        const namedBody = addInvoiceRecipients(result.content, result.recipientByReference);
        const namedChoices = addInvoiceRecipients(choices, result.recipientByReference);
        const content = namedBody === result.content && namedChoices === choices ? historyContent : await replyText(namedBody, namedChoices);
        return await respond({ content, ...(review ? { components: review.components } : {}), ...(result.files.length ? { files: result.files } : {}) },
          { runIds: result.conversationRunIds, productOrderIds: result.observedProductOrderIds, pending: result.conversationPending, historyContent });
      }
      if (action === 'help') return await respond({ content: message || help });
      if (!form && !['create_invoice', 'replace_invoice', 'download_file', 'rebuild_file', 'check_registration', 'show_status', 'review_tracking', 'select_tracking', 'replace_tracking'].includes(action)) throw new Error('지원하는 업무 요청을 확인해 주세요.');
      if (['select_tracking', 'replace_tracking'].includes(action) && !review) throw new Error('현재 작업의 선택 버튼을 사용해 주세요.');
      const importing = action === 'create_invoice' || action === 'replace_invoice' && Boolean(event.attachments?.length);
      date = validateDate(date || (importing ? today() : context.date) || today());
      if (!importing && !runId && date !== context.date) {
        const selected = await api('/api/invoices/latest?date=' + encodeURIComponent(date));
        runId = selected.invoice?.run.id || null;
      } else if (!importing) runId ||= context.runId || null;
      if (!importing && !runId && action !== 'check_registration') return { content: `${date}에 연결된 송장 작업을 찾지 못했습니다. system0에서 작업을 선택해 주세요.` };
      const result = await api('/api/discord/requests', json('POST', { ...scope, requestId: event.id, action: form ? 'select_tracking' : action, date,
        ...(!importing && runId ? { runId } : {}) }));
      if (result.request.status !== 'running') {
        const previous = result.request;
        const latest = previous.runId ? await api('/api/invoices/' + previous.runId).catch(() => null) : null;
        return { content: `${previous.status === 'succeeded' ? '이미 처리한 요청입니다.' : '이전 요청은 실패했습니다. 내용을 확인한 뒤 새 요청으로 진행해 주세요.'}${previous.runId ? ` 송장 작업 #${previous.runId}` : ''}`,
          ...(previous.runId ? { components: buttons(scope, previous.runId, previous.date || date, latest) } : {}) };
      }
      claimed = true;
      const finish = async () => {
        await api(`/api/discord/requests/${event.id}`, json('PATCH', { ...scope, status: 'succeeded', date, ...(runId ? { runId } : {}) }));
        completed = true;
      };
      let detail;
      if (!importing && onProgress && ['check_registration', 'rebuild_file', 'replace_invoice'].includes(action)) {
        await onProgress(message || (action === 'check_registration'
          ? '관련 처리 내역의 네이버 등록 상태를 조회하겠습니다. 송장을 전송하거나 주문 상태를 변경하지 않습니다.'
          : action === 'replace_invoice' ? '현재 작업에서 교체할 수 있는 송장을 확인하겠습니다. 적용 전에 범위를 보여드립니다.'
            : '검토 상태를 확인한 뒤 현재 선택한 송장으로 새 엑셀을 만들겠습니다.'));
      }
      if (importing) {
        if (attachments.length !== 2) throw new Error('네이버 주문파일과 로젠 송장파일, 총 2개를 함께 첨부해 주세요.');
        if (onProgress) await onProgress(message || (action === 'replace_invoice'
          ? '정정 파일을 매칭해 교체 대상을 확인하겠습니다. 적용 전 교체 범위를 보여드립니다.'
          : '네이버 파일의 발송 대상을 기준으로 매칭하겠습니다. 복수 송장은 선택을 요청하겠습니다.'));
        detail = await importInvoiceFiles(api, await attachmentForm(attachments, log), date);
        runId = detail.run.id; await finish();
      } else {
        if (action === 'check_registration') {
          const checked = await api('/api/invoices/check-date', json('POST', { date }));
          await finish();
          const failed = checked.errors?.length || 0;
          if (runId) detail = await api(`/api/invoices/${runId}`);
          const output = detail?.trackingReview?.pendingCount ? reviewOutput(scope, detail, date)
            : { content: detail ? summary(detail) : '', ...(runId ? { components: buttons(scope, runId, date, detail) } : {}) };
          const checkedText = '처리 내역 ' + checked.runIds.length + '개 · 조회 성공 ' + checked.summary.succeeded + '개'
            + (failed ? ' · 일부 조회 실패 ' + failed + '건' : '');
          output.content = checkedText + (output.content ? '\n' + output.content : '');
          return await respondInvoice(output, detail, checked.runIds, true);
        }
        detail = form?.detail || await api(`/api/invoices/${runId}`);
      }
      if (!form && review && (action === 'select_tracking' || !detail.viewVersion.startsWith(review.version))) {
        await finish();
        const output = reviewOutput(scope, detail, date);
        output.content = (action === 'select_tracking' ? '현재 선택창에서 송장을 고른 뒤 선택 적용을 눌러 주세요.' : '작업 내용이 바뀌었습니다. 최신 선택 목록을 확인해 주세요.') + '\n' + output.content;
        return output;
      }
      if (form || action === 'replace_tracking') {
        const choices = form?.choices || (detail.trackingReview?.groups || []).filter(group => group.replacementEligible)
          .map(group => ({ key: group.key, trackingNumber: group.replacementTrackingNumber, mode: 'replace' }));
        if (!choices.length) throw new Error('이번 파일에서 교체할 수 있는 송장이 없습니다. 최신 상태를 확인해 주세요.');
        if (form && onProgress) await onProgress(`선택하신 송장 ${choices.length}건을 아래 내역대로 적용하겠습니다.\n${form.preview}`);
        detail = await api(`/api/invoices/${runId}/tracking`, json('POST', { expectedVersion: detail.viewVersion, choices, actor: `discord:${scope.userId}` }));
        if (form) trackingDrafts.delete(form.key);
      }
      if (!completed) await finish();
      if (form || action === 'replace_invoice' || action === 'review_tracking'
        || needsReview(detail) && !(action === 'download_file' && detail.run.savedFileAvailable)) {
        const output = reviewOutput(scope, detail, date, { showResolved: !form, groupKeys: form?.groupKeys || null, scopeId: form?.scopeId || null });
        if (form) output.content = `송장 ${form.choices.length}건을 적용했습니다.\n${form.preview}\n\n${output.content}`;
        return await respondInvoice(output, detail, undefined, true);
      }
      const output = { content: summary(detail), components: buttons(scope, runId, date, detail) };
      if (action !== 'show_status') {
        const canReceive = detail.run.savedFileAvailable || detail.fileActions?.create || detail.fileActions?.rebuild;
        if (!canReceive) {
          output.content += '\n' + (detail.fileActions?.reason || '현재 검토 내용을 확인해 주세요.');
          return await respondInvoice(output, detail);
        }
        try {
          const rebuilding = action === 'rebuild_file' || action === 'replace_tracking';
          const referenceSelected = review?.action === 'rebuild_file' && detail.trackingReview?.groups.some(group => group.kind === 'reprint_reference' && group.mode);
          output.files = [await getFile(api, detail, referenceSelected ? 'export' : rebuilding && detail.run.savedFileAvailable ? 'rebuild' : 'auto')];
          output.content += `${referenceSelected ? '\n현재 선택한 송장으로 만든 미등록 대상 파일입니다.' : rebuilding ? '\n현재 선택한 송장으로 새로 만든 파일입니다.' : detail.run.savedFileAvailable ? '\n보관된 생성 당시의 파일입니다.' : '\n네이버 업로드용 파일입니다.'}\n파일 생성은 네이버 등록 완료와 별개입니다.`;
          const latest = await api(`/api/invoices/${runId}`);
          output.components = buttons(scope, runId, date, latest);
        } catch (error) {
          if (![400, 409].includes(error.status)) throw error;
          const latest = await api('/api/invoices/' + runId);
          const refreshed = needsReview(latest) ? reviewOutput(scope, latest, date)
            : { content: summary(latest), components: buttons(scope, runId, date, latest) };
          output.content = refreshed.content + '\n' + error.message;
          output.components = refreshed.components;
        }
      }
      return await respondInvoice(output, detail);
    } catch (error) {
      log({ stage: 'request.error', runId, code: error.code, error: error.message });
      if (claimed && !completed) {
        try { await api(`/api/discord/requests/${event.id}`, json('PATCH', { ...scope, status: 'failed', ...(runId ? { runId } : {}) })); } catch { /* 실패 기록을 다시 실행 요청으로 바꾸지 않습니다. */ }
      }
      return { content: error.message || '요청을 처리하지 못했습니다. system0에서 작업 상태를 확인해 주세요.' };
    } finally {
      pending.delete(event.id); channels.delete(channelKey);
      log({ stage: 'request.end', runId, claimed, completed });
    }
  }
  return async function handle(event, options = {}) {
    const scope = { guildId: event.guildId, channelId: event.channelId, userId: event.userId };
    if (!discordScopeAllowed(config, scope)) return { content: '이 서버·채널 또는 계정에는 system0 사용 권한이 없습니다.' };
    const log = data => {
      if (!trace) return;
      try {
        const result = trace({ ...(typeof data === 'function' ? data() : data), ...scope, requestId: event.id });
        result?.catch?.(() => {});
      } catch { /* 로그 오류가 업무를 막지 않습니다. */ }
    };
    log(() => ({ stage: 'request.start', kind: event.kind || (event.buttonId ? 'component' : 'command'), action: event.action,
      text: event.text, replyToId: event.replyToId, botMessageId: event.botMessageId,
      attachments: (event.attachments || []).map(traceFile) }));
    let sequence = 0;
    const api = async (route, parameters) => {
      const data = await requestApi(route, parameters, log, ++sequence);
      presenter.remember([data?.run?.id, data?.invoice?.run?.id, data?.request?.runId, data?.runId, ...(data?.runIds || [])]);
      return data;
    };
    const presenter = invoicePresenter(api, scope);
    const onProgress = options.onProgress && (async text => options.onProgress(await presenter.text(text)));
    const output = await presenter.output(await processRequest(event, { ...options, onProgress, api, presenter }, scope, log));
    log(() => ({ stage: 'request.result', outcome: output ? 'reply_prepared' : 'no_reply', text: output?.content,
      files: (output?.files || []).map(traceFile), componentRows: output?.components?.length || 0 }));
    return output;
  };
}
