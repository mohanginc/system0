import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const launcherPath = fileURLToPath(import.meta.url);
const directory = path.dirname(launcherPath);
const defaultServer = existsSync(path.join(directory, 'server.mjs'))
  ? path.join(directory, 'server.mjs') : path.join(directory, '..', 'server.mjs');
const defaultEnv = () => process.env.SYSTEM0_ENV_FILE || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'system0', '.env');
const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

async function probe(url) {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1000) });
    return { reachable: true, body: await response.json().catch(() => null) };
  } catch { return null; }
}

async function openBrowser(url) {
  if (process.platform !== 'win32') throw new Error('설치판 실행은 Windows에서 지원합니다.');
  await promisify(execFile)('cmd.exe', ['/d', '/c', 'start', '', url], { windowsHide: true, timeout: 5000 });
}

function stopChild(child) {
  if (child.exitCode !== null) return;
  if (child.connected) child.send({ type: 'system0-shutdown' }, () => {});
  else child.kill();
}

export async function launch({ serverPath = defaultServer, envFile = defaultEnv(),
  browser = openBrowser, checkStopped = false, startupTimeout = 10000 } = {}) {
  const configPath = path.resolve(envFile);
  if (!existsSync(configPath) && !checkStopped) throw new Error('운영 설정 파일을 찾을 수 없습니다. 설치 설정을 확인해 주세요.');
  const config = existsSync(configPath) ? parseEnv(readFileSync(configPath, 'utf8')) : {};
  const port = Number(config.PORT || 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('운영 설정의 PORT는 1~65535 사이 숫자여야 합니다.');
  const url = `http://127.0.0.1:${port}`;
  const root = realpathSync(path.dirname(serverPath));
  const sameApp = status => status?.body?.app === 'system0' && typeof status.body.instance === 'string'
    && normalize(status.body.instance) === normalize(root);
  const existing = await probe(url);
  if (checkStopped) return sameApp(existing);
  if (existing) {
    if (!sameApp(existing)) throw new Error(`포트 ${port}를 다른 프로그램이 사용하고 있습니다. 운영 설정의 PORT를 바꿔 주세요.`);
    await browser(url);
    return null;
  }
  const child = spawn(process.execPath, [serverPath], { cwd: root,
    env: { ...process.env, ...config, SYSTEM0_ENV_FILE: configPath, PORT: String(port) },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  const stop = () => stopChild(child);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.once('exit', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
  try {
    const deadline = Date.now() + startupTimeout;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) throw new Error('서버를 시작하지 못했습니다. 위의 오류 안내를 확인해 주세요.');
      const status = await probe(url);
      if (sameApp(status)) {
        console.log('브라우저에서 사용하세요. 서버 종료는 이 창에서 Ctrl+C입니다.');
        await browser(url);
        return child;
      }
      if (status) throw new Error(`포트 ${port}를 다른 프로그램이 사용하고 있습니다.`);
      await delay(150);
    }
    throw new Error('서버 시작 시간이 초과되었습니다. 실행 창의 오류를 확인해 주세요.');
  } catch (error) { stopChild(child); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === launcherPath) {
  const checkStopped = process.argv.includes('--check-stopped');
  try {
    const result = await launch({ checkStopped });
    if (checkStopped) process.exitCode = result ? 1 : 0;
    else if (result) result.once('exit', code => { process.exitCode = code || 0; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
