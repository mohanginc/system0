const orderPageSize = 20;
const batchPath = batchId => `/api/batches/${batchId}`;
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });

export function orderTools({ tool, date, string, choice, array, object, positiveId }) {
  return [
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

  return {
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
