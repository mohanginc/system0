import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, copyFileSync, readFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { launch } from '../installer/launch.mjs';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const launcherPath = fileURLToPath(new URL('../installer/launch.mjs', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
function settings(directory, port) {
  const envFile = path.join(directory, '.env');
  writeFileSync(envFile, `PORT=${port}\nOPENAI_API_KEY=\nDATABASE_PATH=${path.join(directory, 'data.sqlite')}\n`);
  return envFile;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const ended = once(child, 'exit');
  child.send({ type: 'system0-shutdown' }, () => {});
  await ended;
}

test('런처는 지정 설정으로 서버 시작·브라우저 열기·중복 재사용·정상 종료를 수행한다', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-launcher-'));
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const envFile = settings(directory, port), opened = [];
  let child;
  t.after(async () => { await stop(child); rmSync(directory, { recursive: true, force: true }); });
  const options = { serverPath, envFile, browser: async url => { opened.push(url); } };
  assert.equal(await launch({ ...options, checkStopped: true }), false);
  child = await launch(options);
  assert.ok(child?.pid);
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.equal(status.apiKeyConfigured, false, '실제 API 키를 사용하지 않아야 합니다.');
  assert.equal(status.instance, path.dirname(serverPath));
  assert.equal(await launch({ ...options, checkStopped: true }), true);
  const check = spawn(process.execPath, [launcherPath, '--check-stopped'], {
    env: { ...process.env, SYSTEM0_ENV_FILE: envFile }, stdio: 'ignore' });
  assert.equal((await once(check, 'exit'))[0], 1);
  assert.equal(await launch(options), null);
  assert.deepEqual(opened, [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}`]);
  await stop(child);
  assert.equal(child.exitCode, 0);
  assert.equal(await launch({ ...options, checkStopped: true }), false);
  const db = new DatabaseSync(path.join(directory, 'data.sqlite'));
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});

test('다른 서비스 또는 다른 설치 경로는 재사용하지 않으며 설치 확인은 종료 요구 없이 통과한다', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-launcher-'));
  let identity = { app: 'other' };
  const service = http.createServer((_request, response) => response.end(JSON.stringify(identity)));
  const port = await listen(service), envFile = settings(directory, port);
  t.after(async () => { await close(service); rmSync(directory, { recursive: true, force: true }); });
  for (const value of [{ app: 'other' }, { app: 'system0', instance: path.join(directory, 'different') }]) {
    identity = value;
    const options = { serverPath, envFile, browser: async () => assert.fail('다른 서비스를 브라우저로 열면 안 됩니다.') };
    await assert.rejects(launch(options), /다른 프로그램/);
    assert.equal(await launch({ ...options, checkStopped: true }), false);
  }
  assert.equal(existsSync(path.join(directory, 'data.sqlite')), false);
});

test('환경변수의 설정 경로를 보존하고 --check-stopped는 서버·브라우저를 시작하지 않는다', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-launcher-'));
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const envFile = settings(directory, port);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, [launcherPath, '--check-stopped'], {
    env: { ...process.env, SYSTEM0_ENV_FILE: envFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(existsSync(path.join(directory, 'data.sqlite')), false);
  writeFileSync(envFile, 'PORT=invalid\n');
  await assert.rejects(launch({ serverPath, envFile }), /PORT/);
});

test('서버 자체도 포트 점유 시 명확한 오류와 종료 코드 1로 종료한다', async t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-launcher-'));
  const service = http.createServer((_request, response) => response.end('other'));
  const port = await listen(service), envFile = settings(directory, port);
  t.after(async () => { await close(service); rmSync(directory, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, SYSTEM0_ENV_FILE: envFile, PORT: String(port), OPENAI_API_KEY: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let message = '';
  child.stderr.on('data', chunk => { message += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(message, /이미 사용 중/);
});

test('실제 CMD 실행은 한국어·공백 경로와 코드페이지 949·65001에서 번들 Node를 호출한다', {
  skip: process.platform !== 'win32'
}, async t => {
  const source = fileURLToPath(new URL('../installer/start.cmd', import.meta.url));
  const bytes = readFileSync(source);
  assert.ok(bytes.every(byte => byte < 128), '부트스트랩은 ASCII여야 합니다.');
  assert.doesNotMatch(bytes.toString('ascii'), /(?<!\r)\n/, 'CMD 줄바꿈은 CRLF여야 합니다.');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'system0-cmd-'));
  const install = path.join(directory, '한국어 설치 폴더');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(install, 'runtime'), { recursive: true });
  const nodePath = path.join(install, 'runtime', 'node.exe');
  copyFileSync(process.execPath, nodePath);
  copyFileSync(source, path.join(install, 'start.cmd'));
  writeFileSync(path.join(install, 'launch.mjs'), `
    import fs from 'node:fs';
    fs.writeFileSync(new URL('observed.json', import.meta.url), JSON.stringify({
      execPath: process.execPath, argv: process.argv, cwd: process.cwd()
    }));
  `);
  for (const codePage of [949, 65001]) {
    const child = spawn('cmd.exe', ['/d', '/c', `chcp ${codePage} >nul & call "${path.join(install, 'start.cmd')}"`], {
      cwd: directory, windowsVerbatimArguments: true, windowsHide: true, detached: true,
      timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.stdin.end('\r\n');
    assert.equal((await once(child, 'close'))[0], 0, `CP${codePage}: ${output}`);
    const observed = JSON.parse(readFileSync(path.join(install, 'observed.json'), 'utf8'));
    assert.equal(observed.execPath, nodePath, `CP${codePage}: 설치된 Node를 실행해야 합니다.`);
    assert.deepEqual(observed.argv, [nodePath, path.join(install, 'launch.mjs')]);
    assert.equal(observed.cwd, install);
    unlinkSync(path.join(install, 'observed.json'));
  }
});
