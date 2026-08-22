const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { signUpdateRequest, validateSharedSecret } = require('./update-auth.js');

const updaterSocketPath = process.env.UPDATER_SOCKET_PATH || '/run/cloudflared-web-updater/updater.sock';
const updaterSharedSecret = String(process.env.UPDATER_SHARED_SECRET || '');

function isUpdaterConfigured() {
  return validateSharedSecret(updaterSharedSecret);
}

function callUpdater(action, data = {}) {
  if (!isUpdaterConfigured()) {
    const error = new Error('一键更新服务尚未安装。');
    error.code = 'UPDATER_NOT_CONFIGURED';
    return Promise.reject(error);
  }

  const body = JSON.stringify({ action, ...data });
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString('hex');
  const signature = signUpdateRequest(updaterSharedSecret, timestamp, nonce, body);

  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: updaterSocketPath,
      path: '/rpc',
      method: 'POST',
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Updater-Timestamp': timestamp,
        'X-Updater-Nonce': nonce,
        'X-Updater-Signature': signature,
      },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let result = {};
        try {
          result = raw ? JSON.parse(raw) : {};
        } catch (_error) {
          return reject(new Error('一键更新服务返回了无法识别的结果。'));
        }
        if ((response.statusCode || 500) >= 400) {
          const error = new Error(result.message || '一键更新服务暂时不可用。');
          error.statusCode = response.statusCode;
          return reject(error);
        }
        return resolve(result);
      });
    });
    request.on('timeout', () => request.destroy(new Error('连接一键更新服务超时。')));
    request.on('error', error => {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
        const unavailable = new Error('一键更新服务尚未启动。');
        unavailable.code = 'UPDATER_UNAVAILABLE';
        reject(unavailable);
        return;
      }
      reject(error);
    });
    request.end(body);
  });
}

module.exports = { callUpdater, isUpdaterConfigured };
