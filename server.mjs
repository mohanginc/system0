import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { existsSync, rmSync, realpathSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase, batchDetail, listBatches, deleteBatch, deleteRows } from './lib/database.mjs';
import { importFiles, exportDownload } from './lib/excel.mjs';
import { normalizeBatch, reviseRows } from './lib/naming.mjs';
import { listLlmPurposes, llmUsage } from './lib/llm.mjs';
import { shippingBoard, shippingDates } from './lib/shipping.mjs';
import { createNaverClient } from './lib/naver.mjs';
import { previewShippingBoard } from './lib/shipping-preview.mjs';
import { CARRIERS, unlockNaverFiles, importInvoiceFiles, listInvoiceRuns, listInvoiceDrafts, invoiceDetail, invoiceOrderSources, reviseInvoiceItems,
  exportInvoices, downloadInvoices, latestInvoice, refreshInvoiceStatus, refreshOutsideInvoiceStatus } from './lib/invoices.mjs';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.SYSTEM0_ENV_FILE || path.join(projectRoot, '.env');
if (existsSync(envFile)) loadEnvFile(envFile);

export function defaultDatabasePath() {
  const directory = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'system0')
    : path.join(os.homedir(), '.local', 'share', 'system0');
  return path.join(directory, 'system0.sqlite');
}

export function createApp({ databasePath = process.env.DATABASE_PATH || defaultDatabasePath(),
  model = process.env.OPENAI_MODEL || 'gpt-6.1-sol', client, naver = createNaverClient(),
  apiKey = process.env.OPENAI_API_KEY, publicOrigin = process.env.SYSTEM0_PUBLIC_ORIGIN || '' } = {}) {
  let publicHost = '';
  if (publicOrigin) {
    let url;
    try { url = new URL(publicOrigin); } catch { /* 아래에서 잘못된 설정을 거부합니다. */ }
    if (!url || url.protocol !== 'https:' || url.origin !== publicOrigin) {
      throw new Error('SYSTEM0_PUBLIC_ORIGIN은 경로·끝 슬래시가 없는 HTTPS 주소여야 합니다. 예: https://system0.babestellar.com');
    }
    publicHost = url.host;
  }
  const db = openDatabase(databasePath);
  const ai = client === undefined ? (apiKey ? new OpenAI({ apiKey, timeout: 120000, maxRetries: 0 }) : null) : client;
  const running = new Set();
  let previewRunning = false;
  const invoiceChecking = new Set();
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.use((request, response, next) => {
    const host = request.get('host') || '';
    const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    if (!localHost && (!publicHost || host !== publicHost)) return response.status(403).json({ error: publicHost ? '허용된 주소로 접속해 주세요.' : '로컬 주소로 접속해 주세요.' });
    const origin = request.get('origin');
    const expectedOrigin = localHost ? `http://${host}` : publicOrigin;
    const invalidOrigin = origin ? origin !== expectedOrigin : !localHost;
    if (!['GET', 'HEAD'].includes(request.method) && (invalidOrigin || request.get('sec-fetch-site') === 'cross-site')) {
      return response.status(403).json({ error: '외부 페이지에서 이 작업을 요청할 수 없습니다.' });
    }
    response.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  const excelFileFilter = (_request, file, done) => {
      // Multipart filenames are transmitted as UTF-8 bytes by browsers.
      if ([...file.originalname].every(character => character.codePointAt(0) <= 255)) {
        const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
        if (!decoded.includes('\ufffd')) file.originalname = decoded;
      }
      if (!/\.xlsx?$/i.test(file.originalname)) return done(new Error('.xls 또는 .xlsx 파일만 올릴 수 있습니다.'));
      done(null, true);
    };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 100, fields: 0 },
    fileFilter: excelFileFilter });
  const invoiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 100, fields: 3 },
    fileFilter: excelFileFilter }).fields([{ name: 'naverFiles', maxCount: 50 }, { name: 'courierFiles', maxCount: 50 }]);
  const idFrom = request => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('작업 번호를 확인해 주세요.');
    return id;
  };
  const ensureBatch = (request, response, mutating = false) => {
    const id = idFrom(request);
    if (!db.prepare('SELECT id FROM batches WHERE id = ? AND is_deleted = 0').get(id)) {
      response.status(404).json({ error: '작업을 찾을 수 없습니다.' });
      return null;
    }
    if (mutating && running.has(id)) {
      response.status(409).json({ error: 'AI 정리 중입니다. 완료 후 수정하거나 다시 실행해 주세요.' });
      return null;
    }
    return id;
  };

  app.get('/api/status', (_request, response) => response.json({ app: 'system0',
    ...(publicOrigin ? {} : { instance: realpathSync(projectRoot) }), apiKeyConfigured: Boolean(ai), model }));
  app.use('/api/invoices', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/invoices/meta', (_request, response) => response.json({ carriers: CARRIERS }));
  app.get('/api/invoices/drafts', (request, response) => response.json({ drafts: listInvoiceDrafts(db, request.query.date) }));
  app.get('/api/invoices/latest', (request, response) => response.json({ invoice: latestInvoice(db, request.query.date) }));
  app.get('/api/invoices/orders', (request, response) => {
    let batchIds;
    try { batchIds = JSON.parse(request.query.batchIds); }
    catch { throw new Error('조회할 확인한 주문 작업을 선택해 주세요.'); }
    response.json(invoiceOrderSources(db, batchIds));
  });
  app.get('/api/invoices', (request, response) => response.json({ runs: listInvoiceRuns(db, request.query.date) }));
  app.post('/api/invoices/import', invoiceUpload, async (request, response) => {
    if (invoiceChecking.size) return response.status(409).json({ error: '송장 등록 상태를 확인 중입니다. 완료 후 파일을 올려 주세요.' });
    const carrier = CARRIERS.find(value => value.code === request.body?.deliveryCompanyCode);
    if (!carrier) throw new Error('택배사를 선택해 주세요.');
    const naverFiles = request.files?.naverFiles || [], courierFiles = request.files?.courierFiles || [];
    if ([...naverFiles, ...courierFiles].reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) {
      throw new Error('한 번에 업로드하는 파일의 합계는 50MB까지 가능합니다.');
    }
    let batchIds;
    if (request.body?.batchIds !== undefined) {
      try { batchIds = JSON.parse(request.body.batchIds); }
      catch { throw new Error('송장을 연결할 확인한 주문 작업을 선택해 주세요.'); }
    }
    const sourceDate = request.body?.sourceDate;
    if (sourceDate === undefined && batchIds === undefined) throw new Error('송장 처리 날짜를 선택해 주세요.');
    const preparedNaverFiles = await unlockNaverFiles(naverFiles, request.body?.naverPassword);
    if (invoiceChecking.size) return response.status(409).json({ error: '송장 등록 상태를 확인 중입니다. 완료 후 파일을 올려 주세요.' });
    const detail = importInvoiceFiles(db, { naverFiles: preparedNaverFiles, courierFiles, carrier, batchIds, sourceDate, runningBatchIds: [...running] });
    invoiceChecking.add(detail.run.id);
    try {
      response.status(201).json(!detail.run.outsideCheckedAt || detail.outsideOrders.some(order => !order.checkedAt)
        ? await refreshOutsideInvoiceStatus(db, detail.run.id, naver) : detail);
    } finally { invoiceChecking.delete(detail.run.id); }
  });
  const ensureInvoice = (request, response, mutating = false) => {
    const id = Number(request.params.id);
    if (!/^[1-9]\d*$/.test(request.params.id) || !Number.isSafeInteger(id)) throw new Error('송장 처리 번호를 확인해 주세요.');
    if (!db.prepare('SELECT id FROM invoice_runs WHERE id = ?').get(id)) {
      response.status(404).json({ error: '송장 처리 내역을 찾을 수 없습니다.' }); return null;
    }
    if (mutating && invoiceChecking.has(id)) {
      response.status(409).json({ error: '등록 상태를 확인 중입니다. 완료 후 다시 실행해 주세요.' }); return null;
    }
    return id;
  };
  app.get('/api/invoices/:id', (request, response) => {
    const id = ensureInvoice(request, response);
    if (id) response.json(invoiceDetail(db, id));
  });
  app.patch('/api/invoices/:id/items', (request, response) => {
    const id = ensureInvoice(request, response, true);
    if (id) response.json(reviseInvoiceItems(db, id, request.body));
  });
  app.get('/api/invoices/:id/export', (request, response) => {
    const id = ensureInvoice(request, response, true);
    if (!id) return;
    const output = exportInvoices(db, id);
    response.attachment(output.filename).type(output.contentType).send(output.buffer);
  });
  app.get('/api/invoices/:id/download', (request, response) => {
    const id = ensureInvoice(request, response, true);
    if (!id) return;
    if (request.query.rebuild !== undefined && request.query.rebuild !== '1') throw new Error('현재 매칭으로 다시 만들기 선택을 확인해 주세요.');
    try {
      const output = downloadInvoices(db, id, { rebuild: request.query.rebuild === '1' });
      response.attachment(output.filename).type(output.contentType).send(output.buffer);
    } catch (error) {
      if (error.code === 'saved_file_missing') response.status(409).json({ error: error.message, code: error.code });
      else throw error;
    }
  });
  app.post('/api/invoices/:id/check', async (request, response) => {
    const id = ensureInvoice(request, response, true);
    if (!id) return;
    invoiceChecking.add(id);
    try {
      let mainError;
      try { await refreshInvoiceStatus(db, id, naver); } catch (error) { mainError = error; }
      const detail = await refreshOutsideInvoiceStatus(db, id, naver);
      if (mainError) throw mainError;
      response.json(detail);
    }
    catch (error) { response.status(400).json({ error: error.message, invoiceId: id }); }
    finally { invoiceChecking.delete(id); }
  });
  app.use('/api/shipping', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/shipping/board', (request, response) => response.json(shippingBoard(db, request.query.date, request.query.batchId)));
  app.get('/api/shipping/dates', (request, response) => response.json(shippingDates(db, request.query.month)));
  app.post('/api/shipping/preview', async (_request, response) => {
    if (previewRunning) return response.status(409).json({ error: '신규 주문 조회·상품명 정리 중입니다. 완료 후 갱신해 주세요.' });
    previewRunning = true;
    try { response.json(await previewShippingBoard(db, naver, ai, model)); }
    catch (error) { response.status(400).json({ error: error.message }); }
    finally { previewRunning = false; }
  });
  app.get('/api/llm/purposes', (_request, response) => response.json(listLlmPurposes(db)));
  app.get('/api/llm/usage', (request, response) => response.json(llmUsage(db, request.query.from, request.query.to, request.query.purpose)));
  app.get('/api/batches', (request, response) => response.json({ batches: listBatches(db, request.query.date).map(batch => ({ ...batch, running: running.has(batch.id) })) }));
  app.post('/api/import', upload.array('files', 100), (request, response) => {
    const files = request.files || [];
    if (files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) throw new Error('한 번에 업로드하는 파일의 합계는 50MB까지 가능합니다.');
    response.status(201).json(importFiles(db, files));
  });
  app.get('/api/batches/:id', (request, response) => {
    const id = ensureBatch(request, response);
    if (id) response.json(batchDetail(db, id, running.has(id)));
  });
  app.post('/api/batches/:id/normalize', async (request, response) => {
    const id = ensureBatch(request, response, true);
    if (!id) return;
    running.add(id);
    try { response.json(await normalizeBatch(db, id, ai, model, request.body?.rowIds)); }
    catch (error) { response.status(400).json({ error: error.message, batchId: id }); }
    finally { running.delete(id); }
  });
  app.patch('/api/batches/:id/rows', (request, response) => {
    const id = ensureBatch(request, response, true);
    if (id) response.json(reviseRows(db, id, request.body?.changes, request.body?.deletedRowIds));
  });
  app.delete('/api/batches/:id', (request, response) => {
    const id = ensureBatch(request, response, true);
    if (id) response.json(deleteBatch(db, id));
  });
  app.delete('/api/batches/:id/rows', (request, response) => {
    const id = ensureBatch(request, response, true);
    if (id) response.json(deleteRows(db, id, request.body?.rowIds));
  });
  app.get('/api/batches/:id/export', async (request, response) => {
    const id = ensureBatch(request, response, true);
    if (!id) return;
    const output = await exportDownload(db, id, request.query.kind || 'orders');
    response.attachment(output.filename).type(output.contentType).send(output.buffer);
  });
  app.post('/api/backup', (_request, response) => {
    const backup = path.join(os.tmpdir(), `system0-backup-${randomUUID()}.sqlite`);
    try {
      db.prepare('VACUUM INTO ?').run(backup);
      response.download(backup, `system0-backup-${new Date().toISOString().slice(0, 10)}.sqlite`, () => rmSync(backup, { force: true }));
    } catch {
      rmSync(backup, { force: true });
      response.status(500).json({ error: '백업 파일을 만들지 못했습니다. 저장 공간과 권한을 확인해 주세요.' });
    }
  });
  app.use('/api', (_request, response) => response.status(404).json({ error: '지원하지 않는 API입니다.' }));
  app.use(express.static(path.join(projectRoot, 'public'), { dotfiles: 'deny' }));
  app.use((error, _request, response, _next) => {
    const uploadErrors = {
      LIMIT_FILE_SIZE: '파일 하나는 10MB까지 올릴 수 있습니다.',
      LIMIT_FILE_COUNT: '한 번에 엑셀 100개까지 올릴 수 있습니다.',
      LIMIT_FIELD_COUNT: '파일 업로드 요청이 현재 서버와 맞지 않습니다. 서버를 재시작하고 화면을 새로고침한 뒤 다시 시도해 주세요.',
      LIMIT_UNEXPECTED_FILE: '지원하지 않는 파일 항목이거나 종류별 파일 수가 초과되었습니다. 네이버·택배사 파일은 각각 50개까지 올릴 수 있습니다.',
      LIMIT_FIELD_VALUE: '업로드 입력 내용이 너무 큽니다. 입력 내용을 확인해 주세요.',
    };
    const message = error instanceof multer.MulterError
      ? (uploadErrors[error.code] || '파일 업로드 요청을 읽지 못했습니다. 선택한 파일과 입력 내용을 확인해 주세요.')
      : error instanceof SyntaxError ? '요청 내용을 읽을 수 없습니다.' : error.message;
    response.status(400).json({ error: message || '작업에 실패했습니다.' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1~65535 사이여야 합니다.');
  const app = createApp();
  const server = app.listen(port, '127.0.0.1', () => console.log(`system0: http://127.0.0.1:${port}`));
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `포트 ${port}를 이미 사용 중입니다. PORT 값을 바꿔 주세요.` : '서버를 시작하지 못했습니다.');
    app.locals.db.close();
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => { app.locals.db.close(); process.exit(0); });
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  process.on('message', message => { if (message?.type === 'system0-shutdown') close(); });
}
