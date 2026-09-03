const test = require('node:test');
const assert = require('node:assert/strict');

const { signUpdateRequest, verifyUpdateRequest } = require('../update-auth.js');
const {
  buildContainerCreateConfig,
  compactTimestamp,
  isAllowedVersion,
  isNewerVersion,
  readContainerVersion,
} = require('../updater.js');

const secret = 'unit-test-updater-secret-0123456789-abcdef';

test('更新服务签名有时效并且不能被篡改', () => {
  const timestamp = String(Date.now());
  const nonce = '0123456789abcdef0123456789abcdef';
  const body = JSON.stringify({ action: 'update', version: '2026.8.2-zh-cn.10' });
  const signature = signUpdateRequest(secret, timestamp, nonce, body);

  assert.equal(verifyUpdateRequest({ secret, timestamp, nonce, body, signature }), true);
  assert.equal(verifyUpdateRequest({ secret, timestamp, nonce, body: `${body} `, signature }), false);
  assert.equal(verifyUpdateRequest({
    secret,
    timestamp,
    nonce,
    body,
    signature,
    now: Number(timestamp) + 31_000,
  }), false);
});

test('只接受正式中文版本号', () => {
  assert.equal(isAllowedVersion('2026.8.2-zh-cn.10'), true);
  assert.equal(isAllowedVersion('latest'), false);
  assert.equal(isAllowedVersion('../other'), false);
  assert.equal(isAllowedVersion('2026.8.2-rc.1'), false);
  assert.equal(isNewerVersion('2026.8.2-zh-cn.10', '2026.8.2-zh-cn.9'), true);
  assert.equal(isNewerVersion('2026.8.3-zh-cn.16', '2026.8.3-zh-cn.14'), true);
  assert.equal(isNewerVersion('2026.8.2-zh-cn.9', '2026.8.2-zh-cn.10'), false);
  assert.equal(isNewerVersion('2026.8.2-zh-cn.10', '2026.8.2-zh-cn.10'), false);
});

test('新容器使用固定镜像、安全配置和受限挂载', () => {
  const inspect = {
    Config: {
      Image: 'ghcr.io/w87051809/cloudflared-web-zh-cn:2026.8.2-zh-cn.9',
      Env: [
        'APP_VERSION=2026.8.2-zh-cn.9',
        'WEBUI_PORT=14333',
        'PROTOCOL=http2',
        'HA_CONNECTIONS=1',
        'WEBUI_SESSION_SECRET=session-secret-that-must-be-preserved',
        'UPDATER_SHARED_SECRET=old-secret-must-not-be-preserved',
        'UNRELATED_DANGEROUS_ENV=drop-me',
      ],
    },
    HostConfig: { Dns: ['223.5.5.5'] },
    Mounts: [
      { Type: 'bind', Source: '/etc/cloudflared-web', Destination: '/config', RW: true },
      { Type: 'bind', Source: '/etc/cloudflared-web/cloudflared', Destination: '/root/.cloudflared', RW: true },
      { Type: 'bind', Source: '/run/cloudflared-web-updater', Destination: '/run/cloudflared-web-updater', RW: false },
      { Type: 'bind', Source: '/etc', Destination: '/host-etc', RW: true },
    ],
  };

  const config = buildContainerCreateConfig(inspect, '2026.8.2-zh-cn.10', secret);
  assert.equal(config.Image, 'ghcr.io/w87051809/cloudflared-web-zh-cn:2026.8.2-zh-cn.10');
  assert.equal(config.HostConfig.NetworkMode, 'host');
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(config.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(config.HostConfig.Binds.some(value => value.includes('/host-etc')), false);
  assert.equal(config.Env.includes('APP_VERSION=2026.8.2-zh-cn.9'), false);
  assert.equal(config.Env.includes('UNRELATED_DANGEROUS_ENV=drop-me'), false);
  assert.equal(config.Env.includes('HA_CONNECTIONS=1'), false);
  assert.equal(config.Env.includes(`UPDATER_SHARED_SECRET=${secret}`), true);
  assert.equal(readContainerVersion(inspect), '2026.8.2-zh-cn.9');
});

test('缺少更新通信目录或配置目录时停止更新', () => {
  const base = { Config: { Env: [] }, HostConfig: {}, Mounts: [] };
  assert.throws(
    () => buildContainerCreateConfig(base, '2026.8.2-zh-cn.10', secret),
    /更新通信目录/,
  );
});

test('备份时间戳只包含数字', () => {
  assert.equal(compactTimestamp(new Date('2026-08-22T06:53:49.000Z')), '20260822065349');
});
