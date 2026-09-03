const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BACKUP_ROOT,
  DOCKER_SOCKET_PATH,
  UPDATER_SOCKET_DIRECTORY,
  buildMainCreateConfig,
  buildUpdaterCreateConfig,
  compareVersions,
  installationComplete,
  isAllowedVersion,
} = require('../installer.js');

const imageId = `sha256:${'a'.repeat(64)}`;
const secret = 'installer-unit-test-secret-0123456789-abcdef';
const targetVersion = '2026.8.3-zh-cn.16';

test('统一安装器只接受正式中文版本并拒绝错误顺序', () => {
  assert.equal(isAllowedVersion(targetVersion), true);
  assert.equal(isAllowedVersion('latest'), false);
  assert.equal(isAllowedVersion('../image'), false);
  assert.equal(compareVersions(targetVersion, '2026.8.2-zh-cn.12'), 1);
  assert.equal(compareVersions('2026.8.2-zh-cn.12', targetVersion), -1);
  assert.equal(compareVersions(targetVersion, targetVersion), 0);
});

test('迁移现有主服务时保留业务配置并丢弃危险参数', () => {
  const current = {
    Config: {
      Env: [
        'APP_VERSION=2026.8.2-zh-cn.12',
        'WEBUI_PORT=14333',
        'BASIC_AUTH_USER=changed-admin',
        'BASIC_AUTH_PASS=not-used-after-auth-file-exists',
        'WEBUI_SESSION_SECRET=session-secret-that-must-be-preserved',
        'PROTOCOL=http2',
        'HA_CONNECTIONS=1',
        'UPDATER_SHARED_SECRET=old-updater-secret-must-be-replaced',
        'UNRELATED_ENV=drop-me',
      ],
    },
    HostConfig: { Dns: ['223.5.5.5'] },
    Mounts: [
      { Type: 'bind', Source: '/opt/cloudflared-web/config', Destination: '/config', RW: true },
      { Type: 'volume', Name: 'cloudflared-data', Destination: '/root/.cloudflared', RW: true },
      { Type: 'bind', Source: '/etc', Destination: '/host-etc', RW: true },
    ],
  };

  const config = buildMainCreateConfig({ current, targetImage: imageId, sharedSecret: secret });
  assert.equal(config.Image, imageId);
  assert.equal(config.HostConfig.NetworkMode, 'host');
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(config.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.deepEqual(config.HostConfig.Dns, ['223.5.5.5']);
  assert.equal(config.Env.includes('BASIC_AUTH_USER=changed-admin'), true);
  assert.equal(config.Env.includes('WEBUI_SESSION_SECRET=session-secret-that-must-be-preserved'), true);
  assert.equal(config.Env.some(item => item.startsWith('HA_CONNECTIONS=')), false);
  assert.equal(config.Env.some(item => item.startsWith('UNRELATED_ENV=')), false);
  assert.equal(config.Env.includes(`UPDATER_SHARED_SECRET=${secret}`), true);
  assert.equal(config.HostConfig.Binds.includes('/opt/cloudflared-web/config:/config:rw'), true);
  assert.equal(config.HostConfig.Binds.includes('cloudflared-data:/root/.cloudflared:rw'), true);
  assert.equal(config.HostConfig.Binds.some(item => item.includes('/host-etc')), false);
  assert.equal(config.HostConfig.Binds.includes(`${UPDATER_SOCKET_DIRECTORY}:${UPDATER_SOCKET_DIRECTORY}:ro`), true);
  assert.equal(config.HostConfig.Binds.some(item => item.includes(DOCKER_SOCKET_PATH)), false);
});

test('新安装自动生成完整主服务配置', () => {
  const config = buildMainCreateConfig({ targetImage: imageId, sharedSecret: secret });
  assert.equal(config.Env.includes('BASIC_AUTH_USER=admin'), true);
  assert.equal(config.Env.includes('BASIC_AUTH_PASS=123456789'), true);
  assert.equal(config.Env.includes('PROTOCOL=http2'), true);
  assert.equal(config.Env.some(item => item.startsWith('WEBUI_SESSION_SECRET=') && item.length >= 55), true);
  assert.equal(config.HostConfig.Binds.includes('/opt/cloudflared-web/config:/config:rw'), true);
  assert.equal(config.HostConfig.Binds.includes('/opt/cloudflared-web/config/cloudflared:/root/.cloudflared:rw'), true);
});

test('独立更新服务拥有固定且最小化的管理权限', () => {
  const config = buildUpdaterCreateConfig({ targetImage: imageId, sharedSecret: secret });
  assert.equal(config.Image, imageId);
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(config.HostConfig.SecurityOpt, ['no-new-privileges:true']);
  assert.equal(config.HostConfig.Binds.includes(`${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}:rw`), true);
  assert.equal(config.HostConfig.Binds.includes(`${UPDATER_SOCKET_DIRECTORY}:${UPDATER_SOCKET_DIRECTORY}:rw`), true);
  assert.equal(config.HostConfig.Binds.includes(`${BACKUP_ROOT}:${BACKUP_ROOT}:rw`), true);
  assert.equal(config.HostConfig.Binds.some(item => item.includes('/config')), false);
  assert.equal(config.HostConfig.Binds.some(item => item.includes('/root/.cloudflared')), false);
});

test('只有主服务和更新服务同时正确安装才算完成', () => {
  const main = {
    Config: { Env: [
      `APP_VERSION=${targetVersion}`,
      `UPDATER_SHARED_SECRET=${secret}`,
      `UPDATER_SOCKET_PATH=${UPDATER_SOCKET_DIRECTORY}/updater.sock`,
    ] },
    HostConfig: {
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' },
    },
    Mounts: [
      { Destination: '/config', RW: true },
      { Destination: UPDATER_SOCKET_DIRECTORY, RW: false },
    ],
  };
  const updater = {
    Config: { Env: [
      `APP_VERSION=${targetVersion}`,
      `UPDATER_SHARED_SECRET=${secret}`,
      `UPDATER_SOCKET_PATH=${UPDATER_SOCKET_DIRECTORY}/updater.sock`,
      `UPDATER_BACKUP_ROOT=${BACKUP_ROOT}`,
    ] },
    HostConfig: {
      ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' },
    },
    Mounts: [
      { Destination: DOCKER_SOCKET_PATH, RW: true },
      { Destination: UPDATER_SOCKET_DIRECTORY, RW: true },
      { Destination: BACKUP_ROOT, RW: true },
    ],
  };

  assert.equal(installationComplete(main, updater, targetVersion), true);
  assert.equal(installationComplete(main, null, targetVersion), false);
  updater.Config.Env[1] = 'UPDATER_SHARED_SECRET=wrong-secret-value-that-is-long-enough';
  assert.equal(installationComplete(main, updater, targetVersion), false);
});

test('缺少独立配置挂载时停止迁移', () => {
  const current = { Config: { Env: [] }, HostConfig: {}, Mounts: [] };
  assert.throws(
    () => buildMainCreateConfig({ current, targetImage: imageId, sharedSecret: secret }),
    /缺少可写的 \/config/,
  );
});
