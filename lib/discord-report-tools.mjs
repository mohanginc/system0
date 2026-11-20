export function reportTools({ tool, date, string }) {
  const optional = schema => ({ anyOf: [schema, { type: 'null' }] });
  const positiveId = { type: 'integer', minimum: 1 };
  return [
    tool('get_shipping_board', '확인한 주문의 출고 보드를 조회한다. 출고 수량 단위는 묶음이다. 전체 날짜 작업이면 batchId=null, 특정 작업이면 그 날짜에 속하는 번호를 사용한다. search=null은 전체, 검색어는 정리된 제품명 또는 바코드다.', {
      date, batchId: optional(positiveId), search: optional(string),
    }),
    tool('list_shipping_dates', '출고 보드 달력에서 YYYY-MM 월의 작업이 있는 날짜, 날짜별 작업 수, 송장 등록 확인 상태를 조회한다.', {
      month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    }),
    tool('preview_new_orders', '직원이 네이버 신규 주문을 요청했을 때 출고 보드의 신규 주문 현황을 실시간 조회한다. 결제 시각 기준 잔여 수량의 단위는 개다. 주문 상태 변경은 없고 상품명 정리에 AI를 사용할 수 있다. search=null은 전체다.', {
      search: optional(string),
    }),
    tool('search_product_catalog', '상품·바코드 화면의 등록 제품과 바코드 없는 정리된 제품명을 조회한다. search=null은 전체, 검색어는 제품명 일부 또는 바코드다. 제품 등록과 이름 연결은 상품·바코드 웹 화면에서 한다.', {
      search: optional(string),
    }),
    tool('list_ai_usage_purposes', 'AI 호출 내역에서 선택할 수 있는 업무 목적 코드와 기록 시작 시각을 조회한다.', {}),
    tool('get_ai_usage', 'AI 호출 건수, 토큰, USD 추정 비용을 한국 시간 기준 시작일과 종료일을 모두 포함해 조회한다. purpose=null은 모든 업무다. 특정 호출 번호가 있으면 recordId로 지정하고, 일반 조회는 recordId=null이다. 기록 시작 이전에는 호출 여부를 알 수 없고 미산정 비용은 0으로 간주하지 않는다.', {
      from: date, to: date, purpose: optional(string), recordId: optional(positiveId),
    }),
  ];
}

function query(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value != null)).toString();
}

const listLimit = 40;
const searchKey = value => (value || '').normalize('NFC').trim().toLocaleLowerCase('ko');
const count = value => value.toLocaleString('ko-KR');
function shortName(value) {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 70 ? oneLine.slice(0, 67) + '…' : oneLine;
}

function shippingDisplay(report, search) {
  const total = `${count(report.matchingQuantity)}${report.unit} · 상품 ${count(report.matchingGroupCount)}개`;
  if (!search || !report.groups.length) return total;
  return total + ' · ' + report.groups.slice(0, 2).map(group => `${shortName(group.name)} ${count(group.count)}${report.unit}`).join(', ');
}

function shippingGroups(groups, search, unit) {
  const term = searchKey(search);
  const matches = groups.filter(group => searchKey(group.name).includes(term) || group.skuBarcode?.includes(term));
  return { unit, matchingGroupCount: matches.length,
    matchingQuantity: matches.reduce((total, group) => total + group.count, 0),
    groups: matches.slice(0, listLimit).map(({ name, skuBarcode, shipmentType, count, invoiceState, unprepared, needsAttention }) =>
      ({ name, skuBarcode, shipmentType, count, invoiceState, unprepared, needsAttention })) };
}

export function reportHandlers({ api }) {
  return {
    async get_shipping_board({ date, batchId, search }) {
      const data = await api('/api/shipping/board?' + query({ date, batchId }));
      const report = shippingGroups(data.groups, search, '묶음');
      return { date: data.date, selectedBatchId: data.selectedBatchId, summary: data.summary, invoiceState: data.invoiceState,
        batches: data.batches.slice(0, listLimit).map(({ id, createdAt, rowCount }) => ({ id, createdAt, rowCount })),
        batchCount: data.batches.length, ...report,
        display: `출고 보드 · ${data.date}${data.selectedBatchId ? ` 작업 #${data.selectedBatchId}` : ''} · ${shippingDisplay(report, search)}` };
    },
    async list_shipping_dates({ month }) {
      const data = await api('/api/shipping/dates?' + query({ month }));
      return { ...data, display: `출고 달력 · ${data.month} · 작업 있는 날 ${count(data.days.length)}일` };
    },
    async preview_new_orders({ search }) {
      const data = await api('/api/shipping/preview', { method: 'POST' });
      const report = shippingGroups(data.groups, search, '개');
      return { from: data.from, to: data.to, updatedAt: data.updatedAt, summary: data.summary,
        ...report, display: `네이버 신규 주문 · ${shippingDisplay(report, search)}` };
    },
    async search_product_catalog({ search }) {
      const { products, unmatched } = await api('/api/products');
      const term = searchKey(search);
      const registered = products.filter(product => searchKey(product.name).includes(term) || product.barcode.includes(term));
      const missing = unmatched.filter(item => searchKey(item.name).includes(term));
      const matches = search ? registered.slice(0, 2).map(item => `${shortName(item.name)} ${item.barcode}`) : [];
      return { totalRegistered: products.length, totalUnmatched: unmatched.length,
        matchingRegistered: registered.length, matchingUnmatched: missing.length,
        products: registered.slice(0, listLimit), unmatched: missing.slice(0, listLimit),
        display: `상품·바코드 조회 · 등록 상품 ${count(registered.length)}개 · 바코드 없는 제품명 ${count(missing.length)}개${matches.length ? ` · ${matches.join(', ')}` : ''}` };
    },
    async list_ai_usage_purposes() {
      const data = await api('/api/llm/purposes');
      return { ...data, display: `AI 호출 목적 조회 · ${count(data.purposes.length)}개` };
    },
    async get_ai_usage({ from, to, purpose, recordId }) {
      const { trackingStartedAt, days, totals, pricing, records, costs } = await api('/api/llm/usage?' + query({ from, to, purpose }));
      const { days: dailyCosts, ...costTotals } = costs;
      const indicesWithCalls = days.flatMap((day, index) => day.calls ? [index] : []);
      const matchingRecords = recordId === null ? records : records.filter(record => record.id === recordId);
      const usd = value => value === null ? '미산정' : `추정 $${value.toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
      const matchingRecord = matchingRecords[0];
      const total = totals.calls ? `기록된 호출 ${count(totals.calls)}회 · ${usd(costTotals.totalUsd)}${costTotals.unpricedCalls ? ` · 미산정 ${count(costTotals.unpricedCalls)}회` : ''}`
        : '해당 기간에 호출 기록 없음';
      const detail = recordId === null ? total : `호출 #${recordId} · ${matchingRecord ? usd(matchingRecord.costUsd) : '해당 기간에 기록 없음'}`;
      return { from, to, purpose, recordId, trackingStartedAt, totals, pricing, costs: costTotals,
        daysWithCalls: indicesWithCalls.length,
        days: indicesWithCalls.slice(0, listLimit).map(index => ({ ...days[index], costs: dailyCosts[index] })),
        matchingRecords: matchingRecords.length, records: matchingRecords.slice(0, listLimit),
        display: `AI 호출 내역 · ${from}~${to} · ${detail}` };
    },
  };
}
