export function reportTools({ tool, date, string }) {
  const optional = schema => ({ anyOf: [schema, { type: 'null' }] });
  const positiveId = { type: 'integer', minimum: 1 };
  return [
    tool('get_shipping_board', '확인한 주문의 출고보드를 조회한다. 등록 출고의 각 그룹은 구성 상품과 수량이 같은 상자다. boxCount는 상자 수, quantity는 검색에 해당하는 상품 개수다. 기존 엑셀 작업은 출고 묶음 수를 반환한다. 날짜 전체와 등록 출고는 batchId=null, 특정 엑셀 작업은 해당 번호를 사용한다. search=null은 전체이며 상품명이나 바코드로 검색한다.', {
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
    tool('read_product_costs', '상품·바코드 관리와 동일하게 지정한 등록 바코드 제품의 단위 원가와 적용 시작일 기록을 조회한다. 바코드를 모르면 상품 카탈로그에서 후보를 먼저 확인한다.', { barcode: string }),
    tool('add_product_cost', '직원이 바코드 또는 확실히 식별된 상품, 적용 시작일, 원 단위 원가를 요청했을 때 적용일별 원가를 추가한다. 해당 상품의 원가 기록을 먼저 읽고, 사용자가 지정하지 않은 가격이나 적용일은 추정하지 않는다. 기존 원가 기록과 주문에 보존된 적용 원가는 유지된다.', {
      barcode: string, effectiveDate: date, unitCostKrw: { type: 'integer', minimum: 0 },
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

export function reportHandlers({ api, json, applied }) {
  const knownCosts = new Set();
  const costsPath = barcode => '/api/products/' + encodeURIComponent(barcode) + '/costs';
  return {
    async get_shipping_board({ date, batchId, search }) {
      const data = await api('/api/shipping/board?' + query({ date, batchId }));
      const report = shippingGroups(data.groups, search, '묶음');
      const term = searchKey(search);
      const matched = [];
      for (const { name, skuBarcode, shipmentType, quantity, boxCount, components } of data.registered?.groups || []) {
        const selected = components.filter(part => searchKey(part.name).includes(term) || part.skuBarcode?.includes(term));
        if (!selected.length && !searchKey(name).includes(term)) continue;
        const matchingQuantity = selected.length ? boxCount * selected.reduce((sum, part) => sum + part.quantity, 0) : quantity;
        matched.push({ name, skuBarcode, shipmentType, quantity, boxCount, components, matchingQuantity });
      }
      const registered = {
        boxCount: matched.reduce((sum, group) => sum + group.boxCount, 0),
        quantity: matched.reduce((sum, group) => sum + group.matchingQuantity, 0),
        groups: matched.slice(0, listLimit),
      };
      const summary = registered.boxCount
        ? `등록 상자 ${count(registered.boxCount)}개 · 상품 ${count(registered.quantity)}개${report.matchingQuantity ? ` · 기존 ${shippingDisplay(report, search)}` : ''}`
        : shippingDisplay(report, search);
      return { date: data.date, selectedBatchId: data.selectedBatchId, summary: data.summary, invoiceState: data.invoiceState,
        batches: data.batches.slice(0, listLimit).map(({ id, createdAt, rowCount }) => ({ id, createdAt, rowCount })),
        batchCount: data.batches.length, ...report, registered,
        display: `출고 보드 · ${data.date}${data.selectedBatchId ? ` 작업 #${data.selectedBatchId}` : ''} · ${summary}` };
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
        products: registered.slice(0, listLimit).map(({ barcode, name, aliasCount }) => ({ barcode, name, aliasCount })),
        unmatched: missing.slice(0, listLimit),
        display: `상품·바코드 조회 · 등록 상품 ${count(registered.length)}개 · 바코드 없는 제품명 ${count(missing.length)}개${matches.length ? ` · ${matches.join(', ')}` : ''}` };
    },
    async read_product_costs({ barcode }) {
      const data = await api(costsPath(barcode));
      knownCosts.add(barcode);
      return { ...data, costs: data.costs.slice(0, listLimit), recordCount: data.costs.length,
        display: `상품 원가 기록 · ${shortName(data.product.name)} · ${data.costs.length}건` };
    },
    async add_product_cost({ barcode, effectiveDate, unitCostKrw }) {
      if (!knownCosts.has(barcode)) throw new Error('원가를 등록할 상품의 현재 원가 기록을 먼저 조회해 주세요.');
      try {
        const result = await api(costsPath(barcode), json('POST', { effectiveDate, unitCostKrw }));
        applied.push(`상품 원가 저장 · ${barcode} · ${effectiveDate}`);
        return result;
      } catch (error) {
        return { ok: false, reason: error.message, webTarget: { page: 'products' } };
      }
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
