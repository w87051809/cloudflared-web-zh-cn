const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const IMAGE_REPOSITORY = 'ghcr.io/w87051809/cloudflared-web-zh-cn';
const IMAGE_SOURCE = 'https://github.com/w87051809/cloudflared-web-zh-cn';
const VERSION_PATTERN = /^\d+\.\d+\.\d+-zh-cn\.\d+$/;
const MAIN_CONTAINER_NAME = 'cloudflared-web';
const UPDATER_CONTAINER_NAME = 'cloudflared-web-updater';
const DOCKER_SOCKET_PATH = '/var/run/docker.sock';
const UPDATER_SOCKET_DIRECTORY = '/run/cloudflared-web-updater';
const UPDATER_SOCKET_PATH = `${UPDATER_SOCKET_DIRECTORY}/updater.sock`;
const BACKUP_ROOT = '/www/临时文件';
const FRESH_CONFIG_HOST_PATH = '/opt/cloudflared-web/config';
const FRESH_CONFIG_MOUNT_PATH = '/host-install/config';
const PRESERVED_ENV_NAMES = new Set([
  'WEBUI_HOST',
  'WEBUI_PORT',
  'BASIC_AUTH_USER',
  'BASIC_AUTH_PASS',
  'WEBUI_SESSION_SECRET',
  'WEBUI_SESSION_HOURS',
  'WEBUI_COOKIE_SECURE',
  'WEBUI_TRUST_PROXY',
  'WEBUI_ALLOW_REMOTE_SETUP',
  'PROTOCOL',
  'UI_LANGUAGE',
  'EDGE_IP_VERSION',
  'EDGE_BIND_ADDRESS',
  'REGION',
  'RETRIES',
  'GRACE_PERIOD',
  'METRICS_ENABLE',
  'METRICS_PORT',
  'CONFIG_DIR',
  'CLOUDFLARED_BIN',
]);

function dockerRequest(method, requestPath, body, allowedStatuses = [200, 201, 204]) {
  return new Promise((resolve, reject) => {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const request = http.request({
      socketPath: DOCKER_SOCKET_PATH,
      path: requestPath,
      method,
      timeout: 30_000,
      headers: rawBody ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
      } : {},
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size <= 4 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        if (raw && String(response.headers['content-type'] || '').includes('application/json')) {
          try { parsed = JSON.parse(raw); } catch (_error) {}
        }
        if (!allowedStatuses.includes(response.statusCode || 0)) {
          const message = parsed && typeof parsed === 'object' ? parsed.message : '';
          reject(new Error(message || `Docker 接口返回 ${response.statusCode}`));
          return;
        }
        resolve(parsed);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Docker 接口响应超时。')));
    request.on('error', reject);
    request.end(rawBody);
  });
}

async function inspectContainer(name) {
  try {
    return await dockerRequest('GET', `/v1.41/containers/${encodeURIComponent(name)}/json`);
  } catch (error) {
    if (/No such container/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

function envMap(inspect) {
  const result = new Map();
  for (const item of inspect?.Config?.Env || []) {
    const separator = String(item).indexOf('=');
    if (separator <= 0) continue;
    result.set(item.slice(0, separator), item.slice(separator + 1));
  }
  return result;
}

function isAllowedVersion(version) {
  return VERSION_PATTERN.test(String(version || ''));
}

function compareVersions(leftValue, rightValue) {
  const parse = value => {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)-zh-cn\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parse(leftValue);
  const right = parse(rightValue);
  if (!left || !right) throw new Error('无法识别安装版本。');
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function readContainerVersion(inspect) {
  return envMap(inspect).get('APP_VERSION') || '';
}

function validSharedSecret(value) {
  return Buffer.byteLength(String(value || ''), 'utf8') >= 32;
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function uniqueSuffix() {
  return `${compactTimestamp()}-${randomBytes(3).toString('hex')}`;
}

function preservedEnvironment(inspect) {
  const current = envMap(inspect);
  const result = [];
  for (const name of PRESERVED_ENV_NAMES) {
    if (current.has(name)) result.push(`${name}=${current.get(name)}`);
  }
  return result;
}

function existingDataBinds(inspect) {
  const allowedDestinations = new Set(['/config', '/root/.cloudflared']);
  const binds = [];
  let writableConfigFound = false;
  for (const mount of inspect?.Mounts || []) {
    if (!allowedDestinations.has(mount.Destination)) continue;
    if (!['bind', 'volume'].includes(mount.Type)) continue;
    const source = mount.Type === 'volume' ? mount.Name : mount.Source;
    if (!source) throw new Error(`无法读取 ${mount.Destination} 的原始挂载。`);
    const mode = mount.RW === false ? 'ro' : 'rw';
    if (mount.Destination === '/config' && mode === 'rw') writableConfigFound = true;
    binds.push(`${source}:${mount.Destination}:${mode}`);
  }
  if (!writableConfigFound) throw new Error('现有管理端缺少可写的 /config 挂载，不能安全迁移。');
  return binds;
}

function freshDataBinds() {
  return [
    `${FRESH_CONFIG_HOST_PATH}:/config:rw`,
    `${FRESH_CONFIG_HOST_PATH}/cloudflared:/root/.cloudflared:rw`,
  ];
}

function buildMainCreateConfig({ current = null, targetImage, sharedSecret }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(targetImage || ''))) {
    throw new Error('目标镜像摘要格式不正确。');
  }
  if (!validSharedSecret(sharedSecret)) throw new Error('更新服务密钥长度不足。');

  const environment = current ? preservedEnvironment(current) : [
    'WEBUI_HOST=0.0.0.0',
    'WEBUI_PORT=14333',
    'BASIC_AUTH_USER=admin',
    'BASIC_AUTH_PASS=123456789',
    `WEBUI_SESSION_SECRET=${randomBytes(32).toString('hex')}`,
    'WEBUI_SESSION_HOURS=12',
    'WEBUI_COOKIE_SECURE=auto',
    'WEBUI_TRUST_PROXY=true',
    'PROTOCOL=http2',
    'UI_LANGUAGE=zh-CN',
  ];
  environment.push(`UPDATER_SHARED_SECRET=${sharedSecret}`);
  environment.push(`UPDATER_SOCKET_PATH=${UPDATER_SOCKET_PATH}`);

  const dataBinds = current ? existingDataBinds(current) : freshDataBinds();
  const dns = Array.isArray(current?.HostConfig?.Dns) ? current.HostConfig.Dns : [];
  return {
    Image: targetImage,
    Env: environment,
    Entrypoint: ['/nodejs/bin/node', '/var/app/backend/app.js'],
    WorkingDir: '/var/app',
    StopTimeout: 20,
    HostConfig: {
      Binds: [...dataBinds, `${UPDATER_SOCKET_DIRECTORY}:${UPDATER_SOCKET_DIRECTORY}:ro`],
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' },
      SecurityOpt: ['no-new-privileges:true'],
      Dns: dns,
    },
  };
}

function buildUpdaterCreateConfig({ targetImage, sharedSecret }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(targetImage || ''))) {
    throw new Error('目标镜像摘要格式不正确。');
  }
  if (!validSharedSecret(sharedSecret)) throw new Error('更新服务密钥长度不足。');
  return {
    Image: targetImage,
    Env: [
      `UPDATER_SHARED_SECRET=${sharedSecret}`,
      `UPDATER_SOCKET_PATH=${UPDATER_SOCKET_PATH}`,
      `UPDATER_BACKUP_ROOT=${BACKUP_ROOT}`,
    ],
    Entrypoint: ['/nodejs/bin/node'],
    Cmd: ['/var/app/backend/updater.js'],
    WorkingDir: '/var/app',
    StopTimeout: 20,
    HostConfig: {
      Binds: [
        `${DOCKER_SOCKET_PATH}:${DOCKER_SOCKET_PATH}:rw`,
        `${UPDATER_SOCKET_DIRECTORY}:${UPDATER_SOCKET_DIRECTORY}:rw`,
        `${BACKUP_ROOT}:${BACKUP_ROOT}:rw`,
      ],
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' },
      SecurityOpt: ['no-new-privileges:true'],
    },
  };
}

function hasMount(inspect, destination, writable) {
  return (inspect?.Mounts || []).some(mount => (
    mount.Destination === destination && mount.RW === writable
  ));
}

function installationComplete(mainInspect, updaterInspect, targetVersion) {
  if (!mainInspect || !updaterInspect) return false;
  const mainEnv = envMap(mainInspect);
  const updaterEnv = envMap(updaterInspect);
  const secret = mainEnv.get('UPDATER_SHARED_SECRET');
  return (
    readContainerVersion(mainInspect) === targetVersion
    && readContainerVersion(updaterInspect) === targetVersion
    && validSharedSecret(secret)
    && secret === updaterEnv.get('UPDATER_SHARED_SECRET')
    && mainEnv.get('UPDATER_SOCKET_PATH') === UPDATER_SOCKET_PATH
    && updaterEnv.get('UPDATER_SOCKET_PATH') === UPDATER_SOCKET_PATH
    && updaterEnv.get('UPDATER_BACKUP_ROOT') === BACKUP_ROOT
    && hasMount(mainInspect, '/config', true)
    && hasMount(mainInspect, UPDATER_SOCKET_DIRECTORY, false)
    && !hasMount(mainInspect, DOCKER_SOCKET_PATH, true)
    && hasMount(updaterInspect, DOCKER_SOCKET_PATH, true)
    && hasMount(updaterInspect, UPDATER_SOCKET_DIRECTORY, true)
    && hasMount(updaterInspect, BACKUP_ROOT, true)
    && mainInspect.HostConfig?.ReadonlyRootfs === true
    && updaterInspect.HostConfig?.ReadonlyRootfs === true
    && (mainInspect.HostConfig?.SecurityOpt || []).includes('no-new-privileges:true')
    && (updaterInspect.HostConfig?.SecurityOpt || []).includes('no-new-privileges:true')
    && Object.hasOwn(mainInspect.HostConfig?.Tmpfs || {}, '/tmp')
    && Object.hasOwn(updaterInspect.HostConfig?.Tmpfs || {}, '/tmp')
  );
}

async function verifyTargetImage(targetVersion) {
  if (!isAllowedVersion(targetVersion)) throw new Error('安装版本格式不正确。');
  const imageReference = `${IMAGE_REPOSITORY}:${targetVersion}`;
  const inspect = await dockerRequest('GET', `/v1.41/images/${encodeURIComponent(imageReference)}/json`);
  const labels = inspect.Config?.Labels || {};
  const imageEnvironment = envMap(inspect);
  const expectedCoreVersion = targetVersion.split('-zh-cn.', 1)[0];
  if (
    labels['org.opencontainers.image.version'] !== targetVersion
    || String(labels['org.opencontainers.image.source'] || '').replace(/\/$/, '') !== IMAGE_SOURCE
    || imageEnvironment.get('APP_VERSION') !== targetVersion
    || imageEnvironment.get('VERSION') !== expectedCoreVersion
    || !/^sha256:[a-f0-9]{64}$/.test(String(inspect.Id || ''))
  ) {
    throw new Error('镜像版本或来源核对失败。');
  }
  return String(inspect.Id);
}

async function waitForSocket(timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (fs.statSync(UPDATER_SOCKET_PATH).isSocket()) {
        const status = await new Promise(resolve => {
          const request = http.request({
            socketPath: UPDATER_SOCKET_PATH,
            path: '/rpc',
            method: 'POST',
            timeout: 1_000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
          }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
          });
          request.on('timeout', () => {
            request.destroy();
            resolve(0);
          });
          request.on('error', () => resolve(0));
          request.end('{}');
        });
        if (status === 403) return;
      }
    } catch (_error) {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('更新服务启动后没有生成通信接口。');
}

async function waitForMain(port, timeoutMs = 90_000) {
  const safePort = /^\d{2,5}$/.test(String(port || '')) ? Number(port) : 14333;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${safePort}/auth/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) return;
    } catch (_error) {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('管理端启动后没有通过健康检查。');
}

async function setRestartPolicy(name, policy) {
  await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(name)}/update`, {
    RestartPolicy: { Name: policy, MaximumRetryCount: 0 },
  });
}

async function stopContainer(name) {
  await dockerRequest(
    'POST',
    `/v1.41/containers/${encodeURIComponent(name)}/stop?t=20`,
    undefined,
    [204, 304],
  );
}

async function startContainer(name) {
  await dockerRequest(
    'POST',
    `/v1.41/containers/${encodeURIComponent(name)}/start`,
    undefined,
    [204, 304],
  );
}

async function renameContainer(name, nextName) {
  await dockerRequest(
    'POST',
    `/v1.41/containers/${encodeURIComponent(name)}/rename?name=${encodeURIComponent(nextName)}`,
  );
}

async function createContainer(name, config) {
  await dockerRequest(
    'POST',
    `/v1.41/containers/create?name=${encodeURIComponent(name)}`,
    config,
    [201],
  );
}

async function moveFailedContainer(name, suffix) {
  const current = await inspectContainer(name);
  if (!current) return '';
  try { await stopContainer(name); } catch (_error) {}
  const failedName = `${name}-failed-install-${suffix}`;
  await renameContainer(name, failedName);
  await setRestartPolicy(failedName, 'no');
  return failedName;
}

async function rollbackReplacement(name, backupName, suffix, waitAfterRestore) {
  await moveFailedContainer(name, suffix);
  if (!backupName) return;
  await renameContainer(backupName, name);
  await setRestartPolicy(name, 'unless-stopped');
  await startContainer(name);
  if (waitAfterRestore) await waitAfterRestore();
}

async function replaceUpdater(current, createConfig, suffix) {
  const backupName = current ? `${UPDATER_CONTAINER_NAME}-before-install-${suffix}` : '';
  let oldRenamed = false;
  try {
    if (current) {
      await stopContainer(UPDATER_CONTAINER_NAME);
      await renameContainer(UPDATER_CONTAINER_NAME, backupName);
      oldRenamed = true;
      await setRestartPolicy(backupName, 'no');
    }
    await createContainer(UPDATER_CONTAINER_NAME, createConfig);
    await startContainer(UPDATER_CONTAINER_NAME);
    await waitForSocket();
    return backupName;
  } catch (error) {
    await moveFailedContainer(UPDATER_CONTAINER_NAME, suffix);
    if (oldRenamed) {
      await renameContainer(backupName, UPDATER_CONTAINER_NAME);
      await setRestartPolicy(UPDATER_CONTAINER_NAME, 'unless-stopped');
      await startContainer(UPDATER_CONTAINER_NAME);
      await waitForSocket();
    }
    throw error;
  }
}

async function replaceMain(current, createConfig, suffix) {
  const backupName = current ? `${MAIN_CONTAINER_NAME}-before-install-${suffix}` : '';
  let oldRenamed = false;
  try {
    if (current) {
      await stopContainer(MAIN_CONTAINER_NAME);
      await renameContainer(MAIN_CONTAINER_NAME, backupName);
      oldRenamed = true;
      await setRestartPolicy(backupName, 'no');
    }
    await createContainer(MAIN_CONTAINER_NAME, createConfig);
    await startContainer(MAIN_CONTAINER_NAME);
    const port = createConfig.Env.find(item => item.startsWith('WEBUI_PORT='))?.split('=')[1];
    await waitForMain(port);
    return backupName;
  } catch (error) {
    await moveFailedContainer(MAIN_CONTAINER_NAME, suffix);
    if (oldRenamed) {
      await renameContainer(backupName, MAIN_CONTAINER_NAME);
      await setRestartPolicy(MAIN_CONTAINER_NAME, 'unless-stopped');
      await startContainer(MAIN_CONTAINER_NAME);
      const previousPort = envMap(current).get('WEBUI_PORT');
      await waitForMain(previousPort);
    }
    throw error;
  }
}

function writeInstallRecord(record) {
  const directory = path.join(BACKUP_ROOT, `cloudflared-web-install-${uniqueSuffix()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(
    path.join(directory, 'install-record.json'),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
  return directory;
}

async function runInstaller() {
  if (process.platform !== 'linux') throw new Error('统一安装器只支持 Linux、OpenWrt 和 iStoreOS。');
  if (!fs.statSync(DOCKER_SOCKET_PATH).isSocket()) throw new Error('没有找到 Docker 管理接口。');
  fs.mkdirSync(BACKUP_ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(BACKUP_ROOT, 0o700);
  fs.mkdirSync(UPDATER_SOCKET_DIRECTORY, { recursive: true, mode: 0o770 });
  fs.chmodSync(UPDATER_SOCKET_DIRECTORY, 0o770);

  const targetVersion = String(process.env.APP_VERSION || '');
  const targetImage = await verifyTargetImage(targetVersion);
  let currentMain = await inspectContainer(MAIN_CONTAINER_NAME);
  let currentUpdater = await inspectContainer(UPDATER_CONTAINER_NAME);

  const currentMainVersion = readContainerVersion(currentMain);
  if (currentMainVersion && isAllowedVersion(currentMainVersion) && compareVersions(currentMainVersion, targetVersion) > 0) {
    throw new Error(`当前版本 ${currentMainVersion} 比安装器版本新，拒绝降级。`);
  }

  if (!currentMain) {
    fs.mkdirSync(`${FRESH_CONFIG_MOUNT_PATH}/cloudflared`, { recursive: true, mode: 0o700 });
    fs.chmodSync(FRESH_CONFIG_MOUNT_PATH, 0o700);
    fs.chmodSync(`${FRESH_CONFIG_MOUNT_PATH}/cloudflared`, 0o700);
  }

  const mainSecret = envMap(currentMain).get('UPDATER_SHARED_SECRET');
  const updaterSecret = envMap(currentUpdater).get('UPDATER_SHARED_SECRET');
  const sharedSecret = validSharedSecret(updaterSecret)
    ? updaterSecret
    : (validSharedSecret(mainSecret) ? mainSecret : randomBytes(32).toString('hex'));

  if (installationComplete(currentMain, currentUpdater, targetVersion)) {
    await startContainer(UPDATER_CONTAINER_NAME);
    await waitForSocket();
    await startContainer(MAIN_CONTAINER_NAME);
    await waitForMain(envMap(currentMain).get('WEBUI_PORT'));
    console.log(`INSTALLER_RESULT:${JSON.stringify({
      status: 'already_complete',
      version: targetVersion,
      message: '完整安装已经存在，无需重复创建。',
    })}`);
    return;
  }

  const suffix = uniqueSuffix();
  const record = {
    created_at: new Date().toISOString(),
    target_version: targetVersion,
    previous_main_version: currentMainVersion,
    previous_updater_version: readContainerVersion(currentUpdater),
    previous_main_container: currentMain ? MAIN_CONTAINER_NAME : '',
    previous_updater_container: currentUpdater ? UPDATER_CONTAINER_NAME : '',
    status: 'started',
  };
  const recordDirectory = writeInstallRecord(record);

  let updaterBackupName = '';
  let mainBackupName = '';
  let updaterReplaced = false;
  let mainReplaced = false;
  try {
    updaterBackupName = await replaceUpdater(
      currentUpdater,
      buildUpdaterCreateConfig({ targetImage, sharedSecret }),
      suffix,
    );
    updaterReplaced = true;
    mainBackupName = await replaceMain(
      currentMain,
      buildMainCreateConfig({ current: currentMain, targetImage, sharedSecret }),
      suffix,
    );
    mainReplaced = true;
    currentMain = await inspectContainer(MAIN_CONTAINER_NAME);
    currentUpdater = await inspectContainer(UPDATER_CONTAINER_NAME);
    if (!installationComplete(currentMain, currentUpdater, targetVersion)) {
      throw new Error('安装完成后的配置一致性检查没有通过。');
    }
    const completedRecord = {
      ...record,
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      main_backup_container: mainBackupName,
      updater_backup_container: updaterBackupName,
    };
    fs.writeFileSync(
      path.join(recordDirectory, 'install-record.json'),
      `${JSON.stringify(completedRecord, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.log(`INSTALLER_RESULT:${JSON.stringify({
      status: 'succeeded',
      version: targetVersion,
      message: '管理服务和一键更新服务已完整安装。',
      record_directory: recordDirectory,
    })}`);
  } catch (error) {
    if (mainReplaced) {
      try {
        await rollbackReplacement(
          MAIN_CONTAINER_NAME,
          mainBackupName,
          suffix,
          () => waitForMain(envMap(currentMain).get('WEBUI_PORT')),
        );
      } catch (_rollbackError) {}
    }
    if (updaterReplaced) {
      try {
        await rollbackReplacement(
          UPDATER_CONTAINER_NAME,
          updaterBackupName,
          suffix,
          updaterBackupName ? waitForSocket : null,
        );
      } catch (_rollbackError) {}
    }
    const failedRecord = {
      ...record,
      status: 'failed',
      finished_at: new Date().toISOString(),
      message: String(error?.message || '安装失败').replace(/[\r\n]+/g, ' ').slice(0, 300),
    };
    fs.writeFileSync(
      path.join(recordDirectory, 'install-record.json'),
      `${JSON.stringify(failedRecord, null, 2)}\n`,
      { mode: 0o600 },
    );
    throw error;
  }
}

if (require.main === module) {
  runInstaller().catch(error => {
    console.error(`INSTALLER_ERROR:${String(error?.message || '安装失败').replace(/[\r\n]+/g, ' ').slice(0, 400)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BACKUP_ROOT,
  DOCKER_SOCKET_PATH,
  UPDATER_SOCKET_DIRECTORY,
  buildMainCreateConfig,
  buildUpdaterCreateConfig,
  compareVersions,
  envMap,
  installationComplete,
  isAllowedVersion,
  readContainerVersion,
};
