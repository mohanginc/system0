import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 실제 환경 파일과 운영 DB를 읽지 않습니다.
const noEnvFile = path.join(os.tmpdir(), `system0-no-env-${process.pid}-${Date.now()}`);
process.env.SYSTEM0_ENV_FILE = noEnvFile;
const { createApp } = await import('../server.mjs');
const publicOrigin = 'https://system0.babestellar.com';
const publicHost = 'system0.babestellar.com';

async function startApp(t, origin = '') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-origin-'));
  const app = createApp({ databasePath: path.join(directory, 'test.sqlite'), client: null, naver: {}, publicOrigin: origin });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    app.locals.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { port: server.address().port, server };
}

function request(port, { method = 'GET', host = `127.0.0.1:${port}`, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, method,
      path: method === 'GET' ? '/api/status' : '/api/batches/1',
      headers: { Host: host, ...(origin === undefined ? {} : { Origin: origin }), ...headers } }, incoming => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: JSON.parse(body) }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

test('기본 설정은 localhost 접속·로컬 쓰기를 유지하고 외부 Host와 Origin은 거부한다', async t => {
  const { port, server } = await startApp(t);
  assert.equal(server.address().address, '127.0.0.1');
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localhost', '127.0.0.1']) {
    const status = await request(port, { host });
    assert.equal(status.status, 200);
    assert.equal(status.body.app, 'system0');
    assert.equal(typeof status.body.instance, 'string', 'Windows 실행기가 사용하는 instance 정보를 보존합니다.');
    assert.equal((await request(port, { host, method: 'DELETE' })).status, 404);
    assert.equal((await request(port, { host, method: 'DELETE', origin: `http://${host}` })).status, 404);
  }
  assert.equal((await request(port, { host: publicHost })).status, 403);
  assert.equal((await request(port, { method: 'DELETE', origin: publicOrigin })).status, 403);
  assert.equal((await request(port, { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('설정한 HTTPS 도메인 Host와 정확한 쓰기 Origin만 허용하며 로컬 접속도 유지한다', async t => {
  const { port } = await startApp(t, publicOrigin);
  const status = await request(port, { host: publicHost });
  assert.equal(status.status, 200);
  assert.equal(Object.hasOwn(status.body, 'instance'), false, '서버 운영 경로는 외부 접속에 노출하지 않습니다.');
  assert.equal((await request(port, { host: publicHost, method: 'DELETE', origin: publicOrigin })).status, 404);
  assert.equal((await request(port)).status, 200);
  assert.equal((await request(port, { method: 'DELETE', origin: `http://127.0.0.1:${port}` })).status, 404);
  for (const origin of [undefined, 'null', `http://${publicHost}`, `${publicOrigin}/`, `${publicOrigin}:444`,
    'https://outside.example', `http://127.0.0.1:${port}`]) {
    assert.equal((await request(port, { host: publicHost, method: 'DELETE', origin })).status, 403, `거부할 Origin: ${origin}`);
  }
  assert.equal((await request(port, { host: publicHost, method: 'DELETE', origin: publicOrigin,
    headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('다른 Host·포트와 위조된 forwarded 헤더는 허용 범위를 넓히지 않는다', async t => {
  const { port } = await startApp(t, publicOrigin);
  for (const host of ['outside.example', `${publicHost}.outside.example`, `${publicHost}:443`, `${publicHost}:444`, '34.64.207.147']) {
    assert.equal((await request(port, { host, headers: { 'X-Forwarded-Host': publicHost,
      'X-Forwarded-Proto': 'https', Forwarded: `host=${publicHost};proto=https` } })).status, 403);
  }
  assert.equal((await request(port, { host: publicHost, method: 'DELETE', origin: 'https://outside.example',
    headers: { 'X-Forwarded-Host': publicHost, 'X-Forwarded-Proto': 'https' } })).status, 403);
  assert.equal((await request(port, { method: 'DELETE', origin: publicOrigin,
    headers: { 'X-Forwarded-Host': publicHost, 'X-Forwarded-Proto': 'https' } })).status, 403);
});

test('HTTPS origin 외 설정은 실제 서버 시작 전에 실패하고 DB를 만들지 않는다', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-invalid-origin-'));
  const databasePath = path.join(directory, 'must-not-exist.sqlite');
  try {
    for (const origin of ['not-a-url', `http://${publicHost}`, `${publicOrigin}/`, `${publicOrigin}/path`,
      `${publicOrigin}/..`, `https://user@${publicHost}`, `https://user:password@${publicHost}`,
      `${publicOrigin}?query`, `${publicOrigin}?`, `${publicOrigin}#fragment`, `${publicOrigin}#`,
      ` ${publicOrigin}`, `https:////${publicHost}`]) {
      const result = spawnSync(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, SYSTEM0_ENV_FILE: noEnvFile, SYSTEM0_PUBLIC_ORIGIN: origin,
          DATABASE_PATH: databasePath, PORT: '39999', OPENAI_API_KEY: '', NAVER_CLIENT_ID: '', NAVER_CLIENT_SECRET: '' },
        encoding: 'utf8', timeout: 10000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, `실패해야 할 설정: ${origin}`);
      assert.match(result.stderr, /SYSTEM0_PUBLIC_ORIGIN/);
      assert.equal(existsSync(databasePath), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
