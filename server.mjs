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
  model = process.env.OPENAI_MODEL || 'gpt-6.1-sol', client,
  apiKey = process.env.OPENAI_API_KEY } = {}) {
  const db = openDatabase(databasePath);
  const ai = client === undefined ? (apiKey ? new OpenAI({ apiKey, timeout: 120000, maxRetries: 0 }) : null) : client;
  const running = new Set();
  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db;
  app.use((request, response, next) => {
    const host = request.get('host') || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return response.status(403).json({ error: '로컬 주소로 접속해 주세요.' });
    const origin = request.get('origin');
    if (!['GET', 'HEAD'].includes(request.method) && ((origin && origin !== `http://${host}`) || request.get('sec-fetch-site') === 'cross-site')) {
      return response.status(403).json({ error: '외부 페이지에서 이 작업을 요청할 수 없습니다.' });
    }
    response.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 100, fields: 0 },
    fileFilter: (_request, file, done) => {
      // Multipart filenames are transmitted as UTF-8 bytes by browsers.
      if ([...file.originalname].every(character => character.codePointAt(0) <= 255)) {
        const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
        if (!decoded.includes('\ufffd')) file.originalname = decoded;
      }
      if (!/\.xlsx?$/i.test(file.originalname)) return done(new Error('.xls 또는 .xlsx 파일만 올릴 수 있습니다.'));
      done(null, true);
    } });
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

  app.get('/api/status', (_request, response) => response.json({ app: 'system0', instance: realpathSync(projectRoot), apiKeyConfigured: Boolean(ai), model }));
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
    const message = error instanceof multer.MulterError
      ? (error.code === 'LIMIT_FILE_SIZE' ? '파일 하나는 10MB까지 올릴 수 있습니다.' : '한 번에 엑셀 100개까지 올릴 수 있습니다.')
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
