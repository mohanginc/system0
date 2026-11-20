import { createHmac, timingSafeEqual } from 'node:crypto';
import { discordScopeAllowed } from './discord-config.mjs';
import { invoiceConversationPending, runDiscordAgent } from './discord-invoice-agent.mjs';

const maxFileSize = 10 * 1024 * 1024;
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const help = '네이버·로젠 파일을 함께 첨부하고 @system0 에게 요청하세요. 복수 송장은 채팅에서 교체·분할을 선택합니다.\n정정할 때는 “이번 파일의 송장으로 교체해줘”라고 요청하세요.';
const signature = (secret, scope, action, runId, date) => createHmac('sha256', secret)
  .update(JSON.stringify([scope.guildId, scope.channelId, action, runId, date])).digest('hex').slice(0, 24);

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

const reviewActions = { r: 'replace_tracking', s: 'select_tracking', b: 'rebuild_file', v: 'review_tracking' };
function reviewSignature(config, scope, value) {
  return createHmac('sha256', config.secret).update(JSON.stringify([scope.guildId, scope.channelId, scope.userId, value])).digest('hex').slice(0, 20);
}
function reviewButton(config, scope, action, detail, date, index = 0) {
  const code = Object.keys(reviewActions).find(key => reviewActions[key] === action);
  const value = `s0r:${code}:${detail.run.id}:${date}:${detail.viewVersion.slice(0, 20)}:${index}`;
  return `${value}:${reviewSignature(config, scope, value)}`;
}
function parseReviewButton(config, scope, value) {
  const match = /^(s0r:([rsbv]):([1-9]\d*):(\d{4}-\d{2}-\d{2}):([a-f0-9]{20}):(\d{1,6})):([a-f0-9]{20})$/.exec(value || '');
  if (!match || !Number.isSafeInteger(Number(match[3]))
    || !timingSafeEqual(Buffer.from(match[7]), Buffer.from(reviewSignature(config, scope, match[1])))) {
    throw new Error('이 계정과 채널에서 사용할 수 없는 선택 버튼입니다. 최신 상태에서 다시 선택해 주세요.');
  }
  return { action: reviewActions[match[2]], runId: Number(match[3]), date: match[4], version: match[5], index: Number(match[6]) };
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

export function createDiscordHandler({ config, fetcher = fetch }) {
  const pending = new Set(), channels = new Set();
  async function api(route, { binary = false, fallbackName = '네이버_발송처리.xlsx', ...options } = {}) {
    const response = await fetcher(config.baseUrl + route, { signal: AbortSignal.timeout(300000), ...options,
      headers: { 'X-System0-Discord-Key': config.secret, ...options.headers } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : `system0 요청 실패: HTTP ${response.status}`);
      error.status = response.status; error.code = data.code; throw error;
    }
    if (!binary) return response.json();
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plain = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
    const filename = encoded ? decodeURIComponent(encoded[1]) : plain ? (plain[1] || plain[2]).trim() : fallbackName;
    return { attachment: await readDiscordBytes(response), name: filename.replace(/[/\\\r\n\0]/g, '_') };
  }
  async function attachmentForm(attachments) {
    const form = new FormData();
    let total = 0;
    for (const file of attachments) {
      const url = new URL(file.url);
      if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
        || !url.pathname.startsWith('/attachments/') || url.username || url.password || url.port) throw new Error('디스코드에 직접 첨부한 파일만 사용할 수 있습니다.');
      if (!/\.xlsx?$/i.test(file.name) || /[\r\n\0/\\]/.test(file.name)) throw new Error('.xls 또는 .xlsx 파일만 사용할 수 있습니다.');
      if (file.size > maxFileSize) throw new Error('파일 하나는 10MB까지 사용할 수 있습니다.');
      const response = await fetcher(url.href, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      const data = await readDiscordBytes(response);
      total += data.length;
      if (total > 50 * 1024 * 1024) throw new Error('한 번에 업로드하는 파일의 합계는 50MB까지 가능합니다.');
      form.append('files', new Blob([data]), file.name);
    }
    return form;
  }
  async function importInvoiceFiles(form, date) {
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
  const invoiceRunLink = runId => `[#${runId}](${invoiceRunUrl(runId)})`;
  function linkInvoiceReferences(content, runIds, limit) {
    const known = new Set(runIds.map(String));
    let addedLength = 0;
    return content.replace(/(송장[ \t]*작업[ \t]+)(`#([1-9]\d*)`|\*\*#([1-9]\d*)\*\*|#([1-9]\d*))(?![\w`])/g,
      (text, prefix, reference, codeId, boldId, plainId, offset) => {
        const id = codeId || boldId || plainId;
        if (!known.has(id)) return text;
        const link = invoiceRunLink(id);
        if (offset + addedLength + prefix.length + link.length > limit) return text;
        addedLength += link.length - reference.length;
        return prefix + link;
      }).slice(0, limit);
  }
  function workLinks(targets) {
    const pages = { invoices: '/invoices.html', orders: '/', shipping: '/shipping-board.html', products: '/products.html', usage: '/llm-usage.html' };
    const links = targets.map(({ page, runId, batchId }) => {
      if (!Object.hasOwn(pages, page)) return null;
      const link = new URL(pages[page], config.publicOrigin);
      if (runId) link.searchParams.set('run', runId);
      if (batchId) link.searchParams.set('batch', batchId);
      return `[웹에서 작업 열기](${link.href})${batchId ? ' · #' + batchId : ''}`;
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
    return `송장 작업 ${invoiceRunLink(detail.run.id)} · ${detail.run.sourceDate || today()}\n상품주문 ${s.total || 0}건 · 등록 확인 ${s.complete || 0}건 · 송장 찾음 ${s.ready ?? s.connected ?? 0}건 · 확인 필요 ${(s.unknown || 0) + (s.attention || 0) + (s.hold || 0) + (s.missingSaved || 0)}건`;
  }
  async function getFile(detail, mode = 'auto') {
    return api(`/api/invoices/${detail.run.id}/file`, { ...json('POST', { mode, expectedVersion: detail.viewVersion }), binary: true });
  }
  function reviewOutput(scope, detail, date, replacing = false) {
    const review = detail.trackingReview || { groups: [], pendingCount: 0, replacementCount: 0 };
    const output = { content: summary(detail), components: [] };
    if (review.pendingCount) output.content += `\n송장 선택이 필요한 출고 ${review.pendingCount}건입니다.`;
    else if (detail.fileActions?.reviewRequired) output.content += '\n' + detail.fileActions.reason;
    const groups = review.groups.filter(group => (group.needsSelection || group.mode === 'split' && group.splitEligible !== false
      || group.kind === 'assignment' && group.mode === 'assign' && group.assignEligible)
      && !(replacing && group.replacementEligible)).sort((a, b) => Number(b.needsSelection) - Number(a.needsSelection));
    for (const group of groups.slice(0, 2)) {
      const assignment = group.kind === 'assignment';
      const identity = assignment ? `상품주문 ${group.productOrderIds.join(' · ')} · ${group.optionName || group.productName || ''}`
        : `출고 ${group.internalId || '번호 없음'}`;
      output.content += `\n${group.recipient || '수취인 미확인'} · ${identity}${group.reason ? '\n' + group.reason : ''}`;
      if (!group.candidates?.length || group.candidates.length > 12 || group.selectable === false || assignment && !group.assignEligible) continue;
      const options = group.candidates.filter(candidate => candidate.valid !== false && candidate.selectable !== false)
        .flatMap(candidate => (assignment ? ['assign'] : ['replace', 'split'])
        .filter(mode => mode === 'assign' || (mode === 'replace' ? group.replaceEligible !== false && candidate.currentFile !== false : group.splitEligible !== false)).map(mode => ({
        label: `${mode === 'assign' ? '분리 배송' : mode === 'replace' ? '교체' : '분할 대표'} · ${candidate.trackingNumber}`.slice(0, 100),
        value: `${mode}:${candidate.trackingNumber}`,
        default: group.selectedTrackingNumber === candidate.trackingNumber && group.mode === mode,
        description: [candidate.round != null ? `차수 ${candidate.round}` : '', candidate.printedAt || '',
          mode === 'assign' ? `출고 ${candidate.internalId}` : mode === 'replace' ? '다른 번호는 교체 이력으로 보관' : '실물 송장 모두 유지'].filter(Boolean).join(' · ').slice(0, 100),
      })));
      if (!options.length) continue;
      output.components.push({ type: 1, components: [{ type: 3,
        custom_id: reviewButton(config, scope, 'select_tracking', detail, date, review.groups.indexOf(group)),
        placeholder: `${assignment ? identity : group.recipient || group.internalId} 적용 송장 선택`.slice(0, 150), min_values: 1, max_values: 1, options }] });
    }
    if (groups.length > 2) output.content += '\n선택을 저장하면 다음 출고를 표시합니다. 전체 목록은 system0에서 검토할 수 있습니다.';
    const actions = [];
    if (review.replacementCount) {
      output.content += `\n이번 파일로 교체할 수 있는 출고 ${review.replacementCount}건입니다. 기존 번호는 교체 이력으로 남습니다.`;
      actions.push({ type: 2, style: 1, label: '이번 파일의 송장으로 교체', custom_id: reviewButton(config, scope, 'replace_tracking', detail, date) });
    }
    if (!review.pendingCount && !detail.fileActions?.reviewRequired && (detail.fileActions?.create || detail.fileActions?.rebuild)) actions.push({ type: 2, style: 1, label: '선택 완료 · 엑셀 만들기',
      custom_id: reviewButton(config, scope, 'rebuild_file', detail, date) });
    if (actions.length) output.components.push({ type: 1, components: actions });
    output.components.push(...buttons(scope, detail.run.id, date, detail, false));
    return output;
  }
  return async function handle(event, { onProgress, onResult } = {}) {
    const scope = { guildId: event.guildId, channelId: event.channelId, userId: event.userId };
    if (!discordScopeAllowed(config, scope)) return { content: '이 서버·채널 또는 계정에는 system0 사용 권한이 없습니다.' };
    const channelKey = `${scope.guildId}/${scope.channelId}`;
    if (pending.has(event.id)) return null;
    if (channels.has(channelKey)) return { content: '이 채널의 요청을 처리 중입니다. 완료 후 다시 요청해 주세요.' };
    pending.add(event.id); channels.add(channelKey);
    let claimed = false, completed = false, runId;
    try {
      const userText = event.text || '';
      const conversation = event.kind === 'message' && event.botMessageId && userText.trim()
        ? await api('/api/discord/conversation/load', json('POST', { ...scope, replyToId: event.replyToId || null, text: userText }))
        : null;
      if (conversation?.status === 'ambiguous') {
        return { content: '이어갈 작업이 여러 개입니다. 해당 봇 메시지에 답장하거나 송장 작업번호를 적어 주세요.' };
      }
      if (conversation?.status === 'expired') {
        return { content: '답장한 대화의 작업을 찾을 수 없습니다. 송장 작업번호나 상품주문번호를 적어 새로 요청해 주세요.' };
      }
      async function respond(output, { runIds = [], productOrderIds = [], pending = null } = {}) {
        if (!conversation || !output.content) return output;
        if (onResult) await onResult(output);
        try {
          await api('/api/discord/conversation/save', json('POST', { ...scope, messageId: event.id, botMessageId: event.botMessageId,
            conversationId: conversation.conversationId ?? null, userText, botText: output.content,
            runIds: runIds.slice(0, 200), productOrderIds: productOrderIds.slice(0, 200), pending }));
        } catch (error) {
          console.warn('system0 디스코드 업무 대화를 저장하지 못했습니다.', error.code || error.status || error.name);
        }
        return output;
      }
      function respondInvoice(output, detail, runIds = detail ? [detail.run.id] : [], rememberPending = false) {
        return respond(output, { runIds, productOrderIds: [...new Set((detail?.items || []).map(item => item.productOrderId).filter(Boolean))],
          pending: conversation && rememberPending && detail ? invoiceConversationPending(detail) : null });
      }
      const context = await api('/api/discord/context?' + new URLSearchParams(scope));
      let action = event.action, date = event.date, review, message;
      if (event.buttonId?.startsWith('s0r:')) {
        review = parseReviewButton(config, scope, event.buttonId);
        ({ action, runId, date } = review);
      } else if (event.buttonId) ({ action, runId, date } = parseDiscordButton(config, scope, event.buttonId));
      const attachments = event.attachments || [];
      if (!action && attachments.length && conversation?.status !== 'matched') {
        ({ action, date, message } = await api('/api/discord/interpret', json('POST', { ...scope, text: event.text || '',
          date: today(), hasAttachments: true, runId: context.runId || null })));
      }
      if (!action || action === 'work_agent') {
        const agentDate = today();
        const { request } = await api('/api/discord/requests', json('POST', { ...scope, requestId: event.id, action: 'invoice_agent' }));
        if (request.status !== 'running') return { content: request.status === 'succeeded'
          ? '이미 처리한 요청입니다.' : '이전 요청의 결과를 확인한 뒤 새 요청으로 진행해 주세요.' };
        claimed = true;
        let attachmentsUsed = false;
        const claimAttachmentForm = async () => {
          if (attachmentsUsed) throw new Error('이 요청의 파일은 이미 처리했습니다. 다른 업무는 파일을 따로 첨부해 주세요.');
          const form = await attachmentForm(attachments);
          attachmentsUsed = true;
          return form;
        };
        const result = await runDiscordAgent({ api, json, scope, text: userText, today: agentDate, context, conversation, onProgress,
          attachments: attachments.map(({ name, size }) => ({ name, size })), attachmentForm: claimAttachmentForm, importInvoiceFiles });
        runId = result.lastRun?.runId;
        await api(`/api/discord/requests/${event.id}`, json('PATCH', { ...scope, status: 'succeeded',
          ...(runId ? { runId, date: result.lastRun.date || agentDate } : {}) }));
        completed = true;
        const review = result.review && await api('/api/invoices/' + result.review.runId).then(view =>
          reviewOutput(scope, view, view.run.sourceDate || agentDate, result.review.bulkReplacement)).catch(() => null);
        const links = workLinks(result.webTargets);
        const limit = links ? 1998 - links.length : 2000;
        const body = linkInvoiceReferences(result.content, result.invoiceRunIds, limit);
        const content = links ? body + '\n\n' + links : body;
        return await respond({ content, ...(review ? { components: review.components } : {}), ...(result.files.length ? { files: result.files } : {}) },
          { runIds: result.conversationRunIds, productOrderIds: result.observedProductOrderIds, pending: result.conversationPending });
      }
      if (action === 'help') return await respond({ content: message || help });
      if (!['create_invoice', 'replace_invoice', 'download_file', 'rebuild_file', 'check_registration', 'show_status', 'review_tracking', 'select_tracking', 'replace_tracking'].includes(action)) throw new Error('지원하는 업무 요청을 확인해 주세요.');
      if (['select_tracking', 'replace_tracking'].includes(action) && !review) throw new Error('현재 작업의 선택 버튼을 사용해 주세요.');
      const importing = action === 'create_invoice' || action === 'replace_invoice' && Boolean(event.attachments?.length);
      date = validateDate(date || (importing ? today() : context.date) || today());
      if (!importing && !runId && date !== context.date) {
        const selected = await api('/api/invoices/latest?date=' + encodeURIComponent(date));
        runId = selected.invoice?.run.id || null;
      } else if (!importing) runId ||= context.runId || null;
      if (!importing && !runId && action !== 'check_registration') return { content: `${date}에 연결된 송장 작업을 찾지 못했습니다. system0에서 작업을 선택해 주세요.` };
      const result = await api('/api/discord/requests', json('POST', { ...scope, requestId: event.id, action, date,
        ...(!importing && runId ? { runId } : {}) }));
      if (result.request.status !== 'running') {
        const previous = result.request;
        const latest = previous.runId ? await api('/api/invoices/' + previous.runId).catch(() => null) : null;
        return { content: `${previous.status === 'succeeded' ? '이미 처리한 요청입니다.' : '이전 요청은 실패했습니다. 내용을 확인한 뒤 새 요청으로 진행해 주세요.'}${previous.runId ? ` 송장 작업 ${invoiceRunLink(previous.runId)}` : ''}`,
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
        detail = await importInvoiceFiles(await attachmentForm(attachments), date);
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
        detail = await api(`/api/invoices/${runId}`);
      }
      if (review && !detail.viewVersion.startsWith(review.version)) {
        await finish();
        const output = reviewOutput(scope, detail, date);
        output.content = '작업 내용이 바뀌었습니다. 최신 선택 목록을 확인해 주세요.\n' + output.content;
        return output;
      }
      if (action === 'select_tracking' || action === 'replace_tracking') {
        const groups = detail.trackingReview?.groups || [];
        let choices;
        if (action === 'replace_tracking') choices = groups.filter(group => group.replacementEligible)
          .map(group => ({ key: group.key, trackingNumber: group.replacementTrackingNumber, mode: 'replace' }));
        else {
          const group = groups[review.index], value = event.values?.length === 1 && /^(replace|split|assign):([\w-]+)$/.exec(event.values[0]);
          if (!group || !value || value[1] === 'assign' && (group.kind !== 'assignment' || !group.assignEligible)) {
            throw new Error('현재 선택 목록에서 적용할 송장을 선택해 주세요.');
          }
          choices = [{ key: group.key, trackingNumber: value[2], mode: value[1] }];
        }
        if (!choices.length) throw new Error('이번 파일에서 교체할 수 있는 송장이 없습니다. 최신 상태를 확인해 주세요.');
        detail = await api(`/api/invoices/${runId}/tracking`, json('POST', { expectedVersion: detail.viewVersion, choices, actor: `discord:${scope.userId}` }));
      }
      if (!completed) await finish();
      if (action === 'select_tracking' || action === 'replace_invoice' || action === 'review_tracking'
        || needsReview(detail) && !(action === 'download_file' && detail.run.savedFileAvailable)) {
        return await respondInvoice(reviewOutput(scope, detail, date, action === 'replace_invoice'), detail, undefined, true);
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
          output.files = [await getFile(detail, rebuilding && detail.run.savedFileAvailable ? 'rebuild' : 'auto')];
          output.content += `${rebuilding ? '\n현재 선택한 송장으로 새로 만든 파일입니다.' : detail.run.savedFileAvailable ? '\n보관된 생성 당시의 파일입니다.' : '\n네이버 업로드용 파일입니다.'}\n파일 생성은 네이버 등록 완료와 별개입니다.`;
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
      if (claimed && !completed) {
        try { await api(`/api/discord/requests/${event.id}`, json('PATCH', { ...scope, status: 'failed', ...(runId ? { runId } : {}) })); } catch { /* 실패 기록을 다시 실행 요청으로 바꾸지 않습니다. */ }
      }
      return { content: error.message || '요청을 처리하지 못했습니다. system0에서 작업 상태를 확인해 주세요.' };
    } finally { pending.delete(event.id); channels.delete(channelKey); }
  };
}
