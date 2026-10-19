import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { hashSync } from 'bcryptjs';

// 공식 인증 방식: https://apicenter.commerce.naver.com/docs/auth
// 토큰은 이 프로세스의 메모리에서만 사용한다.
const apiRoot = 'https://api.commerce.naver.com/external';

async function requestJson(label, endpoint, options = {}) {
  let response;
  try {
    response = await fetch(`${apiRoot}${endpoint}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new Error(`${label}: 네이버 API에 연결하지 못했습니다. 네트워크를 확인해 주세요.`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.code === 'string' && /^[A-Z0-9_.-]{1,80}$/i.test(body.code)
      ? body.code : 'UNKNOWN';
    throw new Error(`${label}: HTTP ${response.status} (${code})`);
  }
  if (!body || typeof body !== 'object') throw new Error(`${label}: JSON 응답을 확인할 수 없습니다.`);
  return body;
}

async function main() {
  const envFile = process.env.SYSTEM0_ENV_FILE || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'system0', '.env');
  let config;
  try {
    config = parseEnv(readFileSync(envFile, 'utf8'));
  } catch {
    throw new Error('로컬 설정 파일을 읽을 수 없습니다. SYSTEM0_ENV_FILE 경로를 확인해 주세요.');
  }
  const clientId = config.NAVER_CLIENT_ID?.trim();
  const clientSecret = config.NAVER_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || clientId === '애플리케이션ID' || clientSecret === '시크릿') {
    throw new Error('로컬 설정에 실제 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET을 입력해 주세요.');
  }
  const date = process.argv[2] || new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(Date.now() - 86400000));
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error('조회일은 YYYY-MM-DD 형식으로 입력해 주세요.');
  }
  console.log('로컬 설정 확인: ID·시크릿 입력됨');
  const timestamp = Date.now().toString();
  let signature;
  try {
    signature = Buffer.from(hashSync(`${clientId}_${timestamp}`, clientSecret), 'utf8').toString('base64');
  } catch {
    throw new Error('시크릿으로 인증 서명을 만들지 못했습니다. 시크릿 복사 내용을 확인해 주세요.');
  }
  const auth = await requestJson('인증 토큰 발급', '/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId, timestamp, grant_type: 'client_credentials',
      client_secret_sign: signature, type: 'SELF'
    })
  });
  if (typeof auth.access_token !== 'string' || !auth.access_token) {
    throw new Error('인증 토큰 발급 응답에 토큰이 없습니다.');
  }
  console.log('인증 토큰 발급: 성공');
  const headers = { Authorization: `Bearer ${auth.access_token}`, Accept: 'application/json' };
  const settleQuery = new URLSearchParams({ startDate: date, endDate: date, pageNumber: '1', pageSize: '1' });
  const settle = await requestJson('정산 조회', `/v1/pay-settle/settle/daily?${settleQuery}`, { headers });
  if (!Array.isArray(settle.elements)) throw new Error('정산 응답의 내역 형식을 확인할 수 없습니다.');
  console.log(`정산 조회: 성공 (${date}, 표본 ${settle.elements.length}건)`);
  const now = new Date();
  const orderQuery = new URLSearchParams({
    lastChangedFrom: new Date(now.getTime() - 3600000).toISOString(),
    lastChangedTo: now.toISOString(), limitCount: '1'
  });
  const orders = await requestJson('주문 조회', `/v1/pay-order/seller/product-orders/last-changed-statuses?${orderQuery}`, { headers });
  if (!Array.isArray(orders.data?.lastChangeStatuses)) throw new Error('주문 응답의 내역 형식을 확인할 수 없습니다.');
  console.log(`주문 조회: 성공 (최근 1시간, 표본 ${orders.data.lastChangeStatuses.length}건)`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
