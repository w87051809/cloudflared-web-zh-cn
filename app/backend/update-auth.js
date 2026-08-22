const { createHmac, timingSafeEqual } = require('node:crypto');

const REQUEST_TTL_MS = 30 * 1000;

function validateSharedSecret(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32;
}

function signUpdateRequest(secret, timestamp, nonce, body) {
  if (!validateSharedSecret(secret)) throw new Error('更新服务密钥至少需要 32 个字节。');
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${body}`)
    .digest('hex');
}

function verifyUpdateRequest({ secret, timestamp, nonce, body, signature, now = Date.now() }) {
  if (!validateSharedSecret(secret)) return false;
  if (!/^\d{13}$/.test(String(timestamp || ''))) return false;
  if (!/^[a-f0-9]{32}$/i.test(String(nonce || ''))) return false;
  if (!/^[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  if (Math.abs(now - Number(timestamp)) > REQUEST_TTL_MS) return false;

  const expected = Buffer.from(signUpdateRequest(secret, timestamp, nonce, body), 'hex');
  const actual = Buffer.from(String(signature), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

module.exports = {
  REQUEST_TTL_MS,
  signUpdateRequest,
  validateSharedSecret,
  verifyUpdateRequest,
};
