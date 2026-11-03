import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { hashSync } from 'bcryptjs';

const apiRoot = 'https://api.commerce.naver.com/external';
const dayMs = 86400000;
const text = value => typeof value === 'string' ? value.trim() : '';

function settings() {
  const file = process.env.SYSTEM0_ENV_FILE || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'system0', '.env');
  let config = {};
  try { config = parseEnv(readFileSync(file, 'utf8')); } catch { /* 설정이 없으면 갱신 시 안내합니다. */ }
  return { clientId: text(process.env.NAVER_CLIENT_ID) || text(config.NAVER_CLIENT_ID),
    clientSecret: text(process.env.NAVER_CLIENT_SECRET) || text(config.NAVER_CLIENT_SECRET) };
}

// 주문 상태 변경 API는 제공하지 않습니다. 토큰과 조회 결과는 메모리에서만 사용합니다.
export function createNaverClient({ clientId, clientSecret, fetchImpl = fetch, now = Date.now, wait = pause } = {}) {
  if (clientId === undefined && clientSecret === undefined) ({ clientId, clientSecret } = settings());
  let token = '', expiresAt = 0, lastRequestAt = 0;

  async function request(endpoint, options, label, retry = false) {
    for (let attempt = 0; ; attempt++) {
      const delay = 350 - (now() - lastRequestAt);
      if (delay > 0) await wait(delay);
      lastRequestAt = now();
      let response;
      try { response = await fetchImpl(apiRoot + endpoint, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
      catch { throw new Error(`${label}: 네이버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.`); }
      if (retry && (response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await wait(1000 * 2 ** attempt);
        continue;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(`${label}: HTTP ${response.status}. 네이버 인증 설정·권한 또는 호출 제한을 확인해 주세요.`);
        error.status = response.status;
        throw error;
      }
      if (!body || typeof body !== 'object') throw new Error(`${label}: 네이버 응답 형식을 확인할 수 없습니다.`);
      return body;
    }
  }

  async function accessToken() {
    if (token && now() < expiresAt) return token;
    if (!clientId || !clientSecret) throw new Error('네이버 API 설정이 없습니다. 로컬 설정의 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET을 확인하고 서버를 다시 시작해 주세요.');
    const timestamp = String(now());
    let signature;
    try { signature = Buffer.from(hashSync(`${clientId}_${timestamp}`, clientSecret)).toString('base64'); }
    catch { throw new Error('네이버 API 시크릿으로 인증할 수 없습니다. 설정을 확인해 주세요.'); }
    const auth = await request('/v1/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, timestamp, grant_type: 'client_credentials', client_secret_sign: signature, type: 'SELF' }),
    }, '네이버 인증');
    if (!text(auth.access_token)) throw new Error('네이버 인증 응답에 토큰이 없습니다.');
    token = auth.access_token;
    expiresAt = now() + Math.max(0, (Number(auth.expires_in) || 3600) - 60) * 1000;
    return token;
  }

  return {
    async getProductOrderIds(orderId) {
      if (typeof orderId !== 'string' || orderId !== orderId.trim() || !/^[A-Za-z0-9_-]{1,80}$/.test(orderId)) {
        throw new Error('조회할 주문번호를 확인해 주세요.');
      }
      const read = async () => request(`/v1/pay-order/seller/orders/${encodeURIComponent(orderId)}/product-order-ids`, {
        method: 'GET', headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' },
      }, '상품주문번호 조회', true);
      let result;
      try { result = await read(); }
      catch (error) {
        if (error.status !== 401) throw error;
        token = ''; expiresAt = 0;
        result = await read();
      }
      if (!Array.isArray(result.data)
        || result.data.some(id => typeof id !== 'string' || id !== id.trim() || !/^[A-Za-z0-9_-]{1,80}$/.test(id))
        || new Set(result.data).size !== result.data.length) {
        throw new Error('네이버 상품주문번호 목록 응답을 확인할 수 없습니다.');
      }
      // 빈 목록은 등록 완료를 뜻하지 않습니다. 호출자는 미확인 상태로 유지합니다.
      return result.data;
    },
    async queryProductOrders(productOrderIds) {
      if (!Array.isArray(productOrderIds) || !productOrderIds.length || productOrderIds.length > 10000
        || productOrderIds.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 80)
        || new Set(productOrderIds).size !== productOrderIds.length) {
        throw new Error('조회할 상품주문번호를 확인해 주세요.');
      }
      const orders = [];
      for (let offset = 0; offset < productOrderIds.length; offset += 300) {
        const ids = productOrderIds.slice(offset, offset + 300), expected = new Set(ids);
        // POST /query는 조회 전용입니다. 발주 확인·발송 API는 호출하지 않습니다.
        const read = async () => request('/v1/pay-order/seller/product-orders/query', {
          method: 'POST', headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json',
            'Content-Type': 'application/json' },
          body: JSON.stringify({ productOrderIds: ids, quantityClaimCompatibility: true }),
        }, '송장 등록 상태 조회', true);
        let result;
        try { result = await read(); }
        catch (error) {
          if (error.status !== 401) throw error;
          token = ''; expiresAt = 0;
          result = await read();
        }
        if (!Array.isArray(result.data)) throw new Error('네이버 상품주문 상세 응답을 확인할 수 없습니다.');
        const seen = new Set();
        for (const item of result.data) {
          const product = item.productOrder, order = item.order;
          const productOrderId = text(product?.productOrderId), orderId = text(order?.orderId);
          if (!productOrderId || !orderId || !expected.has(productOrderId) || seen.has(productOrderId)
            || !text(product.productOrderStatus) || !Number.isSafeInteger(product.remainQuantity) || product.remainQuantity < 0) {
            throw new Error('네이버 상품주문번호·상태·잔여 수량 응답을 확인할 수 없습니다.');
          }
          seen.add(productOrderId);
          const address = product.shippingAddress || {}, delivery = item.delivery || {};
          if (delivery.trackingNumber != null && typeof delivery.trackingNumber !== 'string') {
            throw new Error('네이버 송장번호 응답의 문자 형식을 확인해 주세요.');
          }
          orders.push({ productOrderId, orderId, status: product.productOrderStatus,
            placeOrderStatus: text(product.placeOrderStatus), remainQuantity: product.remainQuantity,
            trackingNumber: text(delivery.trackingNumber), deliveryCompanyCode: text(delivery.deliveryCompany),
            deliveryMethod: text(delivery.deliveryMethod), deliveryStatus: text(delivery.deliveryStatus),
            isWrongTrackingNumber: delivery.isWrongTrackingNumber === true,
            recipient: text(address.name), phone: text(address.tel1) || text(address.tel2),
            address: text(address.baseAddress), detailAddress: text(address.detailedAddress),
            claimStatus: text(product.claimStatus) });
        }
        if (seen.size !== expected.size) throw new Error('네이버에서 일부 상품주문을 조회하지 못했습니다. 완료 상태로 처리하지 않았습니다.');
      }
      return orders;
    },
    async listNewOrders() {
      const end = now(), start = end - 7 * dayMs;
      const orders = new Map();
      for (let from = start; from < end; from += dayMs) {
        for (let page = 1; ; page++) {
          if (page > 1000) throw new Error('네이버 조회 페이지가 너무 많아 완료하지 못했습니다. 이전 조회 결과를 확인해 주세요.');
          const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(Math.min(from + dayMs, end)).toISOString(),
            rangeType: 'PAYED_DATETIME', productOrderStatuses: 'PAYED', placeOrderStatusType: 'NOT_YET',
            quantityClaimCompatibility: 'true', page: String(page), pageSize: '300' });
          const read = async () => request(`/v1/pay-order/seller/product-orders?${query}`, {
            method: 'GET', headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json' },
          }, '신규 주문 조회', true);
          let result;
          try { result = await read(); }
          catch (error) {
            if (error.status !== 401) throw error;
            token = ''; expiresAt = 0;
            result = await read();
          }
          const data = result.data;
          if (!Array.isArray(data?.contents) || typeof data.pagination?.hasNext !== 'boolean'
            || (data.pagination.hasNext && !data.contents.length)) throw new Error('네이버 주문 목록·페이지 응답을 확인할 수 없습니다.');
          for (const item of data.contents) {
            const product = item.content?.productOrder, order = item.content?.order;
            if (!product || !order || !text(product.productOrderStatus) || !text(product.placeOrderStatus)) {
              throw new Error('네이버 주문 상태 응답을 확인할 수 없습니다.');
            }
            const productOrderId = text(product.productOrderId), orderId = text(order.orderId);
            if (!productOrderId || !orderId || productOrderId !== text(item.productOrderId)) {
              throw new Error('네이버 주문번호·상품주문번호를 확인할 수 없습니다.');
            }
            if (product.productOrderStatus !== 'PAYED' || product.placeOrderStatus !== 'NOT_YET') {
              orders.delete(productOrderId); continue;
            }
            if (!Number.isSafeInteger(product.remainQuantity) || product.remainQuantity < 0 || !text(product.productName)) {
              throw new Error('네이버 상품주문번호·상품명·잔여 수량을 확인할 수 없습니다.');
            }
            if (!product.remainQuantity) { orders.delete(productOrderId); continue; }
            const address = product.shippingAddress || {};
            orders.set(productOrderId, { productOrderId, orderId, originalName: product.productName.trim(),
              productName: product.productName.trim(), optionName: text(product.productOption), quantity: product.remainQuantity,
              recipient: text(address.name), phone: text(address.tel1) || text(address.tel2), address: text(address.baseAddress) });
          }
          if (!data.pagination.hasNext) break;
        }
      }
      return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), orders: [...orders.values()] };
    },
  };
}
