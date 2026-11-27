const orderPageSize = 20;
const batchPath = batchId => `/api/batches/${batchId}`;
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const intakePath = '/api/order-intake';
const intakeTarget = { page: 'intake' };
const intakeStates = { pending: '발주 미확인', hold: '보류', unverified: '주문 상태 미확인' };
const packingPath = intakePath + '/packing';
const packingTarget = { page: 'packing' };

export function orderTools({ tool, date, string, choice, array, object, positiveId }) {
  return [
    tool('collect_naver_orders', '직원이 가져오기를 요청한 네이버 결제 완료·발주 미확인 주문을 system0에 저장하고 상품명을 자동 정리한다. 웹 주문 수집과 같은 API다. lookbackDays=null은 기본 최근 7일이며 다른 기간을 명시하면 일수 1~180을 지정한다. 네이버 발주나 송장을 변경하지 않는다. 저장과 정리 결과를 각각 확인한다.', {
      lookbackDays: nullable({ type: 'integer', minimum: 1, maximum: 180 }),
    }),
    tool('import_coupang_orders', '사용자가 수집하라고 지정한 쿠팡 판매자센터 배송 주문 엑셀 한 개를 현재 메시지에서 불러와 저장하고 상품명을 정리한다. 발송완료나 이미 송장이 있는 행은 출고 대상으로 사용하지 않는다.', {}),
    tool('read_collected_orders', '주문 수집에 남은 네이버·쿠팡 주문을 조회한다. 출고 등록된 수량은 제외한다. query=null은 전체이며 판매채널·주문번호·제품명·옵션·바코드 또는 상태로 좁힌다. offset=0부터 nextOffset으로 이동한다. 수량 단위는 개다.', {
      offset: { type: 'integer', minimum: 0 }, query: nullable(string),
    }),
    tool('retry_collected_order_names', '직원이 요청한 경우 수집된 주문의 미정리 상품명만 다시 정리한다. 재수집 없이 진행하고 직원이 고친 이름과 바코드는 유지한다.', {}),
    tool('save_collected_order_review', '읽은 수집 주문에서 직원이 지정한 상품명 또는 바코드를 저장한다. rowId는 조회 결과의 id로 지정하고 바꾸지 않는 값은 null을 사용한다. 수동 바코드 선택을 해제하고 자동 연결을 사용하려면 빈 문자열로 저장한다.', {
      rowId: positiveId, cleanedName: nullable(string), skuBarcode: nullable(string),
    }),
    tool('read_order_packing', '수집 주문의 현재 상자와 미배정 수량을 조회한다. 전체는 query=null이며 상품주문번호·상품명·바코드·수취인 또는 상자 번호로 좁힐 수 있다. offset=0부터 nextOffset으로 이동한다. 같은 destinationGroup은 현재 조회에서 동일한 수취인과 배송지임을 뜻하며 null은 미확인이다.', {
      query: nullable(string), offset: { type: 'integer', minimum: 0 },
    }),
    tool('save_order_packing', '읽은 수집 주문으로 직원이 명시한 실제 상자 구성을 저장한다. boxes의 각 원소는 한 상자, orderItemId는 조회한 주문 id, quantity는 그 상자에 넣는 개수다. 합배송은 한 상자에 여러 상품, 분리는 여러 상자에 상품 또는 같은 상품의 수량을 나눠 지정한다. 기존 상자를 다시 나누거나 풀 때만 removeBoxIds에 읽은 상자 번호를 넣는다. 해제된 수량 중 새 상자에 배정되지 않은 수량은 미배정으로 돌아간다. 상품이나 수량을 추측하지 않는다.', {
      removeBoxIds: array(positiveId), boxes: array(object({ items: array(object({ orderItemId: positiveId, quantity: positiveId })) })),
    }),
    tool('register_order_dispatch', '직원이 출고 등록을 명시한 수집 주문을 system0 출고보드로 옮긴다. 현재 포장 목록에서 읽은 준비된 상자 번호는 boxIds, 아직 상자에 넣지 않은 상품주문 ID는 orderItemIds에 넣는다. 미배정 주문은 선택한 남은 수량 전부를 한 상자로 등록한다. 일부만 등록하면 남은 수량은 수집 화면에 남는다. 네이버·쿠팡 발송이나 송장 등록을 실행하지 않는다.', {
      boxIds: array(positiveId), orderItemIds: array(positiveId),
    }),
    tool('list_order_batches', '상품명 정리 화면의 주문 작업을 한국 시간 등록일로 조회한다. date=null은 최근 작업 목록이다. 같은 날짜의 오전·오후 작업이 여럿이면 작업번호와 파일명을 확인한다.', {
      date: nullable(date),
    }),
    tool('read_order_batch', '주문 작업의 정리·검수 상태, 상품명 원본·옵션·정리된 제품명, 바코드, 엑셀 행 번호를 읽는다. query=null은 전체이며, 검색할 경우 상품명·옵션·바코드·행 번호 또는 상태(pending, review, attention, confirmed)를 넣는다. 첫 페이지 offset=0, 다음 페이지는 결과의 nextOffset을 사용한다.', {
      batchId: positiveId, offset: { type: 'integer', minimum: 0 }, query: nullable(string),
    }),
    tool('import_order_files', '사용자가 상품명 정리 작업에 쓰라고 명시한 현재 메시지의 주문 엑셀(.xls, .xlsx) 전체를 상품명 정리 화면과 동일하게 새 작업에 불러온다. 파일 부재나 용도 혼재 시 먼저 문의한다. 불러온 batchId로 후속 작업을 수행한다.', {}),
    tool('normalize_order_names', '읽었거나 방금 불러온 주문 작업에서 기존 이름을 재사용하고 원본과 옵션을 함께 읽어 상품명을 정리한다. 전체 미정리는 rowIds=null, 일부 요청은 조회로 확인한 행의 id를 사용한다. 같은 엑셀 행 번호가 여러 파일에 있으면 대상부터 확인한다. 기존 정리·검수 내용은 유지한다.', {
      batchId: positiveId, rowIds: nullable(array(positiveId)),
    }),
    tool('save_order_review', '읽은 주문 작업에서 직원이 지정한 행의 제품명 수정, 검수 메모, 검수 상태를 저장한다. 조회한 rowId를 사용하며 바꾸지 않는 필드는 null이다. 상태는 pending(미정리), review(검수 대기), attention(확인 필요), confirmed(검수 완료)다. 직원 대신 검수 여부를 판단하지 않는다.', {
      batchId: positiveId, changes: array(object({ rowId: positiveId, cleanedName: nullable(string), reviewNote: nullable(string),
        status: nullable(choice('pending', 'review', 'attention', 'confirmed')) })),
    }),
    tool('export_order_file', '읽은 주문 작업에서 웹과 같은 엑셀을 내려받아 첨부한다. orders는 원본 형식을 유지한 정리 주문 파일(여러 원본인 경우 ZIP), names는 중복을 정리한 검수용 상품명 목록이다. 다운로드에는 남은 주문 행마다 정리된 제품명이 필요하다.', {
      batchId: positiveId, kind: choice('orders', 'names'),
    }),
  ];
}

export function orderHandlers({ api, json, text, attachments, attachmentForm, files, applied, onProgress }) {
  const batches = new Map(), seenRows = new Map(), staleReviews = new Set();
  const seenCollected = new Map();
  let packingVersion = null;
  const seenPackingItems = new Set(), seenBoxes = new Set();
  const namedBatches = new Set([...text.matchAll(/(?:주문|상품명\s*정리)\s*작업\s*(?:번호\s*)?#?\s*([1-9]\d*)/g)].map(match => Number(match[1])));
  let importAttempted = false;
  const checkBatch = batchId => {
    if (namedBatches.size && !namedBatches.has(batchId)) throw new Error('요청에 지정한 주문 작업번호를 확인해 주세요.');
  };
  const requireRead = (batchId, rowIds = []) => {
    checkBatch(batchId);
    if (!batches.has(batchId)) throw new Error('상품명 정리 작업을 먼저 조회해 주세요.');
    if (rowIds.some(id => !seenRows.get(batchId).has(id))) throw new Error('변경할 주문 행을 먼저 조회해 주세요.');
    return batches.get(batchId);
  };
  const remember = (detail, offset = 0, query = null) => {
    const { batch, rows, summary } = detail;
    batches.set(batch.id, detail);
    if (!seenRows.has(batch.id)) seenRows.set(batch.id, new Set());
    const term = query?.trim().toLowerCase();
    const matches = term ? rows.filter(row => [row.originalName, row.productName, row.optionName, row.cleanedName, row.skuBarcode,
      row.status, row.id, row.sourceRow].some(value => String(value ?? '').toLowerCase().includes(term))) : rows;
    const page = matches.slice(offset, offset + orderPageSize);
    for (const row of page) seenRows.get(batch.id).add(row.id);
    return { batchId: batch.id, batch, summary, rows: page.map(({ id, originalName, productName, optionName, cleanedName, status,
      skuBarcode, sourceSheet, sourceRow, reviewNote }) => ({ id, originalName, productName, optionName, cleanedName, status,
      skuBarcode, sourceSheet, sourceRow, hasReviewNote: Boolean(reviewNote) })), matchingRows: matches.length,
    nextOffset: offset + page.length < matches.length ? offset + page.length : null };
  };
  const blocked = (batchId, reason) => ({ ok: false, reason, webTarget: { page: 'orders', batchId } });
  const rememberCollected = (data, offset = 0, query = null) => {
    const term = query?.trim().normalize('NFC').toLowerCase();
    const includes = values => !term || values.some(value => String(value ?? '').normalize('NFC').toLowerCase().includes(term));
    const matches = data.orders.filter(row => includes([row.productOrderId, row.orderId, row.productName, row.optionName,
      row.provider, { naver: '네이버', coupang: '쿠팡' }[row.provider],
      row.cleanedName, row.skuBarcode, row.namingStatus, row.state, intakeStates[row.state],
      ...(!row.skuBarcode ? ['바코드 없음'] : []), ...(row.namingStatus === 'pending' ? ['미정리'] : [])]));
    const rows = matches.slice(offset, offset + orderPageSize);
    for (const row of rows) seenCollected.set(row.id, row.reviewVersion);
    const matchingIds = new Set(matches.map(row => row.id));
    const groups = data.groups.map(({ name, skuBarcode, count, needsAttention, shipments }) => ({
      name, skuBarcode, needsAttention,
      count: includes([name, skuBarcode]) ? count
        : shipments.reduce((sum, row) => sum + (matchingIds.has(row.id) ? row.quantity : 0), 0),
    })).filter(group => group.count > 0);
    return {
      updatedAt: data.updatedAt, from: data.from, to: data.to, summary: data.summary, collection: data.collection,
      rows: rows.map(({ id, productOrderId, orderId, productName, optionName, cleanedName, skuBarcode, quantity, namingStatus, state, provider }) =>
        ({ id, productOrderId, orderId, productName, optionName, cleanedName, skuBarcode, quantity, namingStatus, state, provider })),
      matchingRows: matches.length, nextOffset: offset + rows.length < matches.length ? offset + rows.length : null,
      preparationQuantity: groups.reduce((total, group) => total + group.count, 0),
      groups: groups.slice(0, orderPageSize),
    };
  };
  const runIntake = async (action, progress, saved, input = {}) => {
    await onProgress?.(progress);
    try {
      const data = await api(intakePath + '/' + action, json('POST', input));
      if (saved) applied.push(`네이버 주문 저장 · 새 상품주문 ${data.collection.added}건 · 갱신 ${data.collection.updated}건`);
      else if (!data.namingError) applied.push(`저장 주문 상품명 정리 · 미정리 ${data.summary.pendingCount}건`);
      return { ...rememberCollected(data), webTarget: intakeTarget, ...(data.namingError ? { reason: data.namingError } : {}) };
    } catch (error) {
      return { ok: false, reason: error.message, webTarget: intakeTarget };
    }
  };
  const rememberPacking = (data, offset = 0, query = null) => {
    if (packingVersion !== data.version) {
      packingVersion = data.version;
      seenPackingItems.clear();
      seenBoxes.clear();
    }
    const term = query?.trim().normalize('NFC').toLowerCase();
    const matches = values => !term || values.some(value => String(value ?? '').normalize('NFC').toLowerCase().includes(term));
    const orders = data.orders.filter(order => matches([order.orderId, order.productOrderId, order.cleanedName, order.productName,
      order.optionName, order.skuBarcode, order.recipient]));
    const ids = new Set(orders.map(order => order.id));
    const boxes = data.boxes.filter(box => String(box.id) === term || box.items.some(item => ids.has(item.orderItemId)));
    const orderPage = orders.slice(offset, offset + orderPageSize);
    const boxPage = boxes.slice(offset, offset + orderPageSize);
    for (const row of orderPage) seenPackingItems.add(row.id);
    for (const box of boxPage) {
      seenBoxes.add(box.id);
      for (const item of box.items) seenPackingItems.add(item.orderItemId);
    }
    return { summary: data.summary, matchingOrders: orders.length, matchingBoxes: boxes.length,
      nextOffset: offset + orderPageSize < Math.max(orders.length, boxes.length) ? offset + orderPageSize : null,
      orders: orderPage.map(({ id, orderId, productOrderId, productName, cleanedName, optionName, skuBarcode,
        quantity, allocatedQuantity, availableQuantity, destinationReady, destinationGroup, state }) => ({
        id, orderId, productOrderId, productName, cleanedName, optionName, skuBarcode,
        quantity, allocatedQuantity, availableQuantity, destinationReady, destinationGroup, state,
      })),
      boxes: boxPage.map(({ id, items, needsReview }) => ({ id, needsReview,
        items: items.map(({ orderItemId, quantity }) => ({ orderItemId, quantity })),
      })),
    };
  };

  return {
    async collect_naver_orders({ lookbackDays }) {
      return runIntake('collect', '네이버의 발주 미확인 주문을 가져와 상품명을 정리하겠습니다.', true,
        lookbackDays === null ? {} : { lookbackDays });
    },
    async import_coupang_orders() {
      if (attachments?.length !== 1) throw new Error('쿠팡 주문 엑셀 한 개를 이 메시지에 첨부해 주세요.');
      if (importAttempted) throw new Error('이 메시지의 파일은 이미 불러왔습니다.');
      await onProgress?.('쿠팡 주문 파일을 불러와 상품명을 정리하겠습니다.');
      try {
        const form = await attachmentForm();
        const file = form.get('files');
        form.delete('files');
        form.set('file', file);
        importAttempted = true;
        const data = await api(intakePath + '/coupang', { method: 'POST', body: form });
        applied.push(`쿠팡 주문 저장 · 새 상품주문 ${data.collection.added}건 · 갱신 ${data.collection.updated}건`);
        return { ...rememberCollected(data), webTarget: intakeTarget, ...(data.namingError ? { reason: data.namingError } : {}) };
      } catch (error) {
        return { ok: false, reason: error.message, webTarget: intakeTarget };
      }
    },
    async read_collected_orders({ offset, query }) {
      const view = rememberCollected(await api(intakePath), offset, query);
      return { ...view, display: `수집 주문 · 상품주문 ${view.matchingRows}건 · 수량 ${view.preparationQuantity}개` };
    },
    async retry_collected_order_names() {
      return runIntake('normalize', '수집 주문의 미정리 상품명을 다시 정리하겠습니다.', false);
    },
    async save_collected_order_review({ rowId, cleanedName, skuBarcode }) {
      const expected = seenCollected.get(rowId);
      if (!expected) throw new Error('수정할 수집 주문을 먼저 조회해 주세요.');
      if (cleanedName === null && skuBarcode === null) throw new Error('수정할 상품명이나 바코드를 지정해 주세요.');
      try {
        const data = await api(`${intakePath}/orders/${rowId}`, json('PATCH', { cleanedName, skuBarcode, expected }));
        applied.push('수집 주문 검수 저장 · 상품주문 1건');
        return { ...rememberCollected(data, 0, data.orders.find(row => row.id === rowId)?.productOrderId || null), webTarget: intakeTarget };
      } catch (error) {
        return { ok: false, reason: error.message, webTarget: intakeTarget };
      }
    },
    async read_order_packing({ offset, query }) {
      const view = rememberPacking(await api(packingPath), offset, query);
      return { ...view, display: `포장 조회 · 상자 ${view.matchingBoxes}개 · 상품주문 ${view.matchingOrders}건` };
    },
    async save_order_packing({ removeBoxIds, boxes }) {
      if (!packingVersion || removeBoxIds.some(id => !seenBoxes.has(id))
        || boxes.some(box => box.items.some(item => !seenPackingItems.has(item.orderItemId)))) {
        throw new Error('변경할 상자와 상품주문을 먼저 조회해 주세요.');
      }
      try {
        const data = await api(packingPath, json('PATCH', { expectedVersion: packingVersion, removeBoxIds, boxes }));
        applied.push(`포장 저장 · 새 상자 ${boxes.length}개 · 해제 ${removeBoxIds.length}개`);
        return { ...rememberPacking(data), webTarget: packingTarget };
      } catch (error) {
        return { ok: false, reason: error.message, webTarget: packingTarget };
      }
    },
    async register_order_dispatch({ boxIds, orderItemIds }) {
      if (!packingVersion || boxIds.some(id => !seenBoxes.has(id)) || orderItemIds.some(id => !seenPackingItems.has(id))) {
        throw new Error('출고 등록할 상자와 상품주문을 먼저 조회해 주세요.');
      }
      try {
        const data = await api(intakePath + '/dispatch', json('POST', { expectedVersion: packingVersion, boxIds, orderItemIds }));
        applied.push(`출고 등록 · 상자 ${data.registeredCount}개 · 상품 ${data.registeredQuantity}개`);
        return { date: data.date, registeredCount: data.registeredCount, registeredQuantity: data.registeredQuantity,
          webTarget: { page: 'shipping', date: data.date } };
      } catch (error) {
        return { ok: false, reason: error.message, webTarget: packingTarget };
      }
    },
    async list_order_batches({ date }) {
      const query = date ? '?' + new URLSearchParams({ date }) : '';
      const { batches: results } = await api('/api/batches' + query);
      return { batches: results.slice(0, 30), total: results.length, display: `${date || '최근'} 주문 작업 조회 · ${results.length}개` };
    },
    async read_order_batch({ batchId, offset, query }) {
      checkBatch(batchId);
      const view = remember(await api(batchPath(batchId)), offset, query);
      const { total, pending, review, attention, confirmed } = view.summary;
      return { ...view, display: `주문 작업 #${batchId} · ${total}행 · 미정리 ${pending}행 · 검수 대기 ${review}행 · 확인 필요 ${attention}행 · 검수 완료 ${confirmed}행` };
    },
    async import_order_files() {
      if (!attachments?.length) throw new Error('이 메시지에 주문 엑셀을 첨부해 주세요.');
      if (importAttempted) throw new Error('이 요청의 파일은 이미 처리했습니다. 작업 목록에서 결과를 확인해 주세요.');
      const form = await attachmentForm();
      importAttempted = true;
      await onProgress?.('첨부한 주문 엑셀을 상품명 정리 작업으로 불러오겠습니다.');
      const detail = await api('/api/import', { method: 'POST', body: form });
      if (namedBatches.size) namedBatches.add(detail.batch.id);
      applied.push(`주문 엑셀 불러오기 · 주문 작업 #${detail.batch.id} · ${detail.summary.total}행`);
      return remember(detail);
    },
    async normalize_order_names({ batchId, rowIds }) {
      if (rowIds && (!rowIds.length || new Set(rowIds).size !== rowIds.length)) throw new Error('정리할 주문 행을 확인해 주세요.');
      requireRead(batchId, rowIds ?? []);
      const route = batchPath(batchId);
      const before = await api(route);
      if (before.batch.running) return blocked(batchId, '상품명 정리가 진행 중입니다. 완료 후 다시 확인해 주세요.');
      const selected = rowIds && new Set(rowIds);
      const pending = new Set(before.rows.filter(row => row.status === 'pending' && !row.cleanedName.trim() && !row.generatedName.trim()
        && (!selected || selected.has(row.id))).map(row => row.id));
      if (!pending.size) return remember(before);
      await onProgress?.(`주문 작업 #${batchId}의 미정리 상품명을 정리하겠습니다.`);
      const report = detail => {
        const count = detail.rows.filter(row => pending.has(row.id) && row.cleanedName.trim()).length;
        if (count) applied.push(`상품명 정리 · 주문 작업 #${batchId} · ${count}행`);
        return remember(detail);
      };
      try {
        return report(await api(route + '/normalize', json('POST', rowIds === null ? {} : { rowIds })));
      } catch (error) {
        const after = await api(route).catch(() => null);
        return { ...(after ? report(after) : {}), ...blocked(batchId, error.message) };
      }
    },
    async save_order_review({ batchId, changes }) {
      const before = requireRead(batchId, changes.map(change => change.rowId));
      const staleReason = '조회한 뒤 검수 내용이 바뀌었습니다. 현재 내용을 확인해 주세요.';
      if (staleReviews.has(batchId)) return blocked(batchId, staleReason);
      if (!changes.some(change => change.cleanedName !== null || change.reviewNote !== null || change.status !== null)) {
        throw new Error('저장할 상품명이나 검수 내용을 지정해 주세요.');
      }
      const previous = new Map(before.rows.map(row => [row.id, row]));
      if (changes.some(change => !previous.has(change.rowId))) return blocked(batchId, staleReason);
      const updates = changes.map(change => {
        const { cleanedName, reviewNote, status } = previous.get(change.rowId);
        return { id: change.rowId, cleanedName: change.cleanedName ?? cleanedName, reviewNote: change.reviewNote ?? reviewNote,
          status: change.status ?? status, expected: { cleanedName, reviewNote, status } };
      });
      await onProgress?.(`주문 작업 #${batchId}의 상품명·검수 변경을 확인하겠습니다.`);
      try {
        const detail = await api(batchPath(batchId) + '/rows', json('PATCH', { changes: updates }));
        applied.push(`상품명·검수 저장 · 주문 작업 #${batchId} · ${updates.length}행`);
        return remember(detail);
      } catch (error) {
        if (error.code === 'stale_order_review') staleReviews.add(batchId);
        if (error.status === 409) return blocked(batchId, error.message);
        throw error;
      }
    },
    async export_order_file({ batchId, kind }) {
      requireRead(batchId);
      const route = batchPath(batchId), detail = await api(route);
      if (detail.batch.running) return blocked(batchId, '상품명 정리가 진행 중입니다. 완료 후 엑셀을 받을 수 있습니다.');
      if (!detail.rows.length) return blocked(batchId, '남아 있는 주문 행이 없습니다.');
      if (detail.rows.some(row => !row.cleanedName.trim())) return blocked(batchId, '정리된 제품명이 비어 있는 행이 있습니다. 먼저 정리하거나 직접 입력해 주세요.');
      if (files.length >= 3) return blocked(batchId, '한 요청의 파일은 3개까지 받을 수 있습니다.');
      const fallbackName = kind === 'names' ? '상품명목록.xlsx' : detail.batch.fileCount === 1 ? '정리된주문.xlsx' : `주문_상품명정리_${batchId}.zip`;
      try {
        const file = await api(`${route}/export?${new URLSearchParams({ kind })}`, { binary: true, fallbackName });
        files.push(file);
        applied.push(`상품명 정리 파일 첨부 · 주문 작업 #${batchId} · ${file.name}`);
        return { batchId, name: file.name, attached: true };
      } catch (error) {
        return blocked(batchId, error.message);
      }
    },
  };
}
