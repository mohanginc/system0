const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: '2-digit', hour12: true });
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const fileTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayLabel = date => /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일` : '';
const workReference = () => /송장[ \t]*작업(?:[ \t]*번호)?[ \t]*(?:`#([1-9]\d*)`|\*\*#([1-9]\d*)\*\*|#([1-9]\d*))(?![\w`])/g;
const referenceId = match => Number(match[1] || match[2] || match[3]);
const filePattern = /네이버_발송처리_([1-9]\d*)(_현재매칭재생성|_미등록)?\.xlsx/g;
const normalizeReferences = text => text
  .replace(/(?:송장[ \t]*작업[ \t]+)?\[(?:송장[ \t]*작업[ \t]+)?#([1-9]\d*)\]\(https?:\/\/[^\s)]+\/invoices\.html\?run=\d+\)/g, '송장 작업 #$1')
  .replace(/`(송장[ \t]*작업[ \t]+#[1-9]\d*)`/g, '$1');
const particles = ['은는', '이가', '을를', '과와'];

function displayParticle(label, next) {
  const particle = /^[은는이가을를과와](?=$|\s|[,.!?])/.exec(next)?.[0];
  if (!particle) return '';
  const lastSyllable = label.match(/[가-힣](?=[^가-힣]*$)/)?.[0];
  const endsWithConsonant = (lastSyllable.charCodeAt(0) - 0xac00) % 28 !== 0;
  return particles.find(pair => pair.includes(particle))[endsWithConsonant ? 0 : 1];
}

export function invoiceLinkLabel(run) {
  const date = dayLabel(run?.sourceDate);
  if (!date) return '송장 작업 열기';
  if (!Number.isFinite(Date.parse(run.createdAt))) return `${date} 송장 작업`;
  const created = new Date(run.createdAt), actualDate = calendar.format(created), time = clock.format(created);
  const position = run.sameMinuteOrder ? ` · ${run.sameMinuteOrder}번째` : '';
  if (actualDate !== run.sourceDate) return `${date} 송장 작업${run.sameDayCount > 1 ? ` (${dayLabel(actualDate)} ${time})` : ''}${position}`;
  const period = clock.formatToParts(created).find(part => part.type === 'dayPeriod')?.value;
  return `${date} ${run.sameDayCount > 1 ? time : period} 송장 작업${position}`;
}

export function invoiceTextReferences(text, known) {
  const references = [...normalizeReferences(text).matchAll(workReference())].map(referenceId);
  const files = [...text.matchAll(filePattern)].map(match => Number(match[1]));
  return [...references, ...files].filter(id => known.has(id));
}

export function invoiceAttachmentName(name, metadata) {
  return name.replace(filePattern, (_name, id, suffix = '') => {
    const run = metadata.get(Number(id));
    const date = dayLabel(run?.sourceDate) ? '_' + run.sourceDate : '';
    const time = run?.sameDayCount > 1 && Number.isFinite(Date.parse(run.createdAt)) ? '_' + fileTime.format(new Date(run.createdAt)).replace(':', '') : '';
    const position = run?.sameMinuteOrder ? `_${run.sameMinuteOrder}번째` : '';
    return `네이버_발송처리${date}${time}${position}${suffix}.xlsx`;
  });
}

export function renderInvoiceReferences(content, known, metadata, url, limit = 2000) {
  const text = invoiceAttachmentName(normalizeReferences(content), metadata);
  let rendered = '', from = 0;
  for (const match of text.matchAll(workReference())) {
    const id = referenceId(match), visible = known.has(id);
    const before = text.slice(from, match.index);
    if (rendered.length + before.length >= limit) return rendered + before.slice(0, limit - rendered.length);
    rendered += before;
    const label = visible ? invoiceLinkLabel(metadata.get(id)) : '송장 작업';
    const end = match.index + match[0].length, particle = displayParticle(label, text.slice(end));
    const replacement = (visible ? `[${label}](${url(id)})` : label) + particle;
    if (rendered.length + replacement.length > limit) return rendered + label.slice(0, limit - rendered.length);
    rendered += replacement;
    from = end + particle.length;
  }
  return rendered + text.slice(from, from + limit - rendered.length);
}
