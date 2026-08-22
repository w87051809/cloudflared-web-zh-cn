const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { verifyUpdateRequest, validateSharedSecret } = require('./update-auth.js');

const IMAGE_REPOSITORY = 'ghcr.io/w87051809/cloudflared-web-zh-cn';
const RELEASE_API = 'https://api.github.com/repos/w87051809/cloudflared-web-zh-cn/releases/latest';
const VERSION_PATTERN = /^\d+\.\d+\.\d+-zh-cn\.\d+$/;
const MAIN_CONTAINER_NAME = 'cloudflared-web';
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const UPDATER_SOCKET_PATH = process.env.UPDATER_SOCKET_PATH || '/run/cloudflared-web-updater/updater.sock';
const BACKUP_ROOT = process.env.UPDATER_BACKUP_ROOT || '/www/临时文件';
const SHARED_SECRET = String(process.env.UPDATER_SHARED_SECRET || '');
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

let updateState = {
  status: 'ready',
  message: '一键更新服务已就绪。',
  current_version: '',
  target_version: '',
  previous_container: '',
  started_at: '',
  finished_at: '',
};
let updateRunning = false;
const usedNonces = new Map();

function isAllowedVersion(version) {
  return VERSION_PATTERN.test(String(version || ''));
}

function isNewerVersion(candidate, current) {
  const parse = value => {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)-zh-cn\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parse(candidate);
  const right = parse(current);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

async function getLatestReleaseVersion() {
  const response = await fetch(RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cloudflared-web-zh-cn-updater',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`版本服务返回 ${response.status}`);
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (release.draft || release.prerelease || !isAllowedVersion(version)) {
    throw new Error('最新公开版本信息不完整。');
  }
  return version;
}

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
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = raw;
        if (raw && String(response.headers['content-type'] || '').includes('application/json')) {
          try { parsed = JSON.parse(raw); } catch (_error) {}
        }
        if (!allowedStatuses.includes(response.statusCode || 0)) {
          const dockerMessage = parsed && typeof parsed === 'object' ? parsed.message : '';
          return reject(new Error(dockerMessage || `Docker 接口返回 ${response.statusCode}`));
        }
        return resolve(parsed);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Docker 接口响应超时。')));
    request.on('error', reject);
    request.end(rawBody);
  });
}

function pullImage(version) {
  return new Promise((resolve, reject) => {
    const requestPath = `/v1.41/images/create?fromImage=${encodeURIComponent(IMAGE_REPOSITORY)}&tag=${encodeURIComponent(version)}`;
    const request = http.request({
      socketPath: DOCKER_SOCKET_PATH,
      path: requestPath,
      method: 'POST',
      timeout: 15 * 60 * 1000,
    }, response => {
      let pending = '';
      let streamError = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        pending = `${pending}${chunk}`.slice(-128 * 1024);
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.error) streamError = String(item.error);
          } catch (_error) {}
        }
      });
      response.on('end', () => {
        if (pending.trim()) {
          try {
            const item = JSON.parse(pending);
            if (item.error) streamError = String(item.error);
          } catch (_error) {}
        }
        if (response.statusCode !== 200) return reject(new Error(`下载镜像失败（${response.statusCode}）。`));
        if (streamError) return reject(new Error(streamError));
        return resolve();
      });
    });
    request.on('timeout', () => request.destroy(new Error('下载镜像超时。')));
    request.on('error', reject);
    request.end();
  });
}

async function verifyPulledImage(version) {
  const imageReference = `${IMAGE_REPOSITORY}:${version}`;
  const expectedCoreVersion = version.split('-zh-cn.', 1)[0];
  const inspect = await dockerRequest('GET', `/v1.41/images/${encodeURIComponent(imageReference)}/json`);
  const labels = inspect.Config?.Labels || {};
  const imageVersion = String(labels['org.opencontainers.image.version'] || '');
  const imageSource = String(labels['org.opencontainers.image.source'] || '').replace(/\/$/, '');
  const appVersionEnv = (inspect.Config?.Env || []).find(value => value.startsWith('APP_VERSION='));
  const coreVersionEnv = (inspect.Config?.Env || []).find(value => value.startsWith('VERSION='));
  if (
    imageVersion !== version
    || appVersionEnv !== `APP_VERSION=${version}`
    || coreVersionEnv !== `VERSION=${expectedCoreVersion}`
    || imageSource !== 'https://github.com/w87051809/cloudflared-web-zh-cn'
    || !/^sha256:[a-f0-9]{64}$/.test(String(inspect.Id || ''))
  ) {
    throw new Error('下载的镜像身份校验失败。');
  }
  return String(inspect.Id);
}

async function inspectContainer(name) {
  return dockerRequest('GET', `/v1.41/containers/${encodeURIComponent(name)}/json`);
}

function readContainerVersion(inspect) {
  const item = (inspect.Config?.Env || []).find(value => value.startsWith('APP_VERSION='));
  const version = item ? item.slice('APP_VERSION='.length) : '';
  return isAllowedVersion(version) ? version : '';
}

function buildContainerCreateConfig(inspect, targetVersion, sharedSecret = SHARED_SECRET, targetImage = '') {
  if (!isAllowedVersion(targetVersion)) throw new Error('目标版本格式不正确。');
  if (targetImage && !/^sha256:[a-f0-9]{64}$/.test(targetImage)) throw new Error('目标镜像摘要格式不正确。');
  const preservedEnv = (inspect.Config?.Env || []).filter(item => {
    const name = String(item).split('=', 1)[0];
    return PRESERVED_ENV_NAMES.has(name);
  });
  preservedEnv.push(`UPDATER_SHARED_SECRET=${sharedSecret}`);
  preservedEnv.push(`UPDATER_SOCKET_PATH=${UPDATER_SOCKET_PATH}`);

  const allowedDestinations = new Set(['/config', '/root/.cloudflared', path.dirname(UPDATER_SOCKET_PATH)]);
  const updaterMount = (inspect.Mounts || []).find(mount => mount.Destination === path.dirname(UPDATER_SOCKET_PATH));
  const configMount = (inspect.Mounts || []).find(mount => mount.Destination === '/config');
  if (!updaterMount || updaterMount.RW !== false) {
    throw new Error('更新通信目录必须以只读方式挂载到主服务。');
  }
  if (!configMount || configMount.RW !== true) {
    throw new Error('主服务配置目录必须以可写方式单独挂载。');
  }
  const binds = (inspect.Mounts || [])
    .filter(mount => allowedDestinations.has(mount.Destination) && ['bind', 'volume'].includes(mount.Type))
    .map(mount => {
      const source = mount.Type === 'volume' ? mount.Name : mount.Source;
      return `${source}:${mount.Destination}:${mount.RW === false ? 'ro' : 'rw'}`;
    });

  return {
    Image: targetImage || `${IMAGE_REPOSITORY}:${targetVersion}`,
    Env: preservedEnv,
    Entrypoint: ['/nodejs/bin/node', '/var/app/backend/app.js'],
    WorkingDir: '/var/app',
    StopTimeout: 20,
    HostConfig: {
      Binds: binds,
      NetworkMode: 'host',
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16777216' },
      SecurityOpt: ['no-new-privileges:true'],
      Dns: Array.isArray(inspect.HostConfig?.Dns) ? inspect.HostConfig.Dns : [],
    },
  };
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function writeBackupRecord(inspect, backupName, targetVersion) {
  const backupDirectory = path.join(BACKUP_ROOT, `cloudflared-web-auto-update-${compactTimestamp()}`);
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  const record = {
    created_at: new Date().toISOString(),
    previous_container: backupName,
    previous_container_id: String(inspect.Id || '').slice(0, 64),
    previous_image: String(inspect.Config?.Image || ''),
    previous_version: readContainerVersion(inspect),
    target_version: targetVersion,
  };
  fs.writeFileSync(
    path.join(backupDirectory, 'update-record.json'),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
  return backupDirectory;
}

async function waitForMainService(port) {
  const safePort = /^\d{2,5}$/.test(String(port || '')) ? Number(port) : 14333;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${safePort}/auth/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) return;
    } catch (_error) {}
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error('新版本启动后未能通过健康检查。');
}

async function rollbackUpdate(backupName, newContainerCreated) {
  if (newContainerCreated) {
    try {
      await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(MAIN_CONTAINER_NAME)}/stop?t=5`, undefined, [204, 304]);
    } catch (_error) {}
    try {
      await dockerRequest('DELETE', `/v1.41/containers/${encodeURIComponent(MAIN_CONTAINER_NAME)}?force=true`, undefined, [204]);
    } catch (_error) {}
  }
  await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(backupName)}/rename?name=${encodeURIComponent(MAIN_CONTAINER_NAME)}`);
  await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(MAIN_CONTAINER_NAME)}/update`, {
    RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
  });
  try {
    await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(MAIN_CONTAINER_NAME)}/start`, undefined, [204, 304]);
  } catch (_error) {}
}

async function performUpdate(requestedVersion) {
  let backupName = '';
  let oldRenamed = false;
  let newContainerCreated = false;
  updateRunning = true;
  updateState = {
    status: 'checking',
    message: '正在核对公开发布版本。',
    current_version: '',
    target_version: requestedVersion,
    previous_container: '',
    started_at: new Date().toISOString(),
    finished_at: '',
  };

  try {
    const latestVersion = await getLatestReleaseVersion();
    if (latestVersion !== requestedVersion || !isAllowedVersion(requestedVersion)) {
      throw new Error('请求版本与仓库最新公开版本不一致。');
    }

    const current = await inspectContainer(MAIN_CONTAINER_NAME);
    const currentVersion = readContainerVersion(current);
    updateState.current_version = currentVersion;
    if (currentVersion === requestedVersion) {
      updateState.status = 'succeeded';
      updateState.message = '当前已经是最新版本。';
      updateState.finished_at = new Date().toISOString();
      return;
    }
    if (!currentVersion || !isNewerVersion(requestedVersion, currentVersion)) {
      throw new Error('更新服务拒绝降级或无法识别的当前版本。');
    }

    updateState.status = 'downloading';
    updateState.message = `正在下载 ${requestedVersion}，当前服务不会中断。`;
    await pullImage(requestedVersion);
    const targetImage = await verifyPulledImage(requestedVersion);

    updateState.status = 'installing';
    updateState.message = '新版本已下载，正在保留旧版并切换服务。';
    const stamp = compactTimestamp();
    backupName = `cloudflared-web-before-auto-update-${currentVersion || 'unknown'}-${stamp}`;
    updateState.previous_container = backupName;
    writeBackupRecord(current, backupName, requestedVersion);

    await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(MAIN_CONTAINER_NAME)}/rename?name=${encodeURIComponent(backupName)}`);
    oldRenamed = true;
    await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(backupName)}/update`, {
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    });

    const createConfig = buildContainerCreateConfig(current, requestedVersion, SHARED_SECRET, targetImage);
    await dockerRequest('POST', `/v1.41/containers/create?name=${encodeURIComponent(MAIN_CONTAINER_NAME)}`, createConfig, [201]);
    newContainerCreated = true;

    await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(backupName)}/stop?t=20`, undefined, [204, 304]);
    await dockerRequest('POST', `/v1.41/containers/${encodeURIComponent(MAIN_CONTAINER_NAME)}/start`, undefined, [204, 304]);

    const portEntry = (createConfig.Env || []).find(item => item.startsWith('WEBUI_PORT='));
    await waitForMainService(portEntry ? portEntry.split('=')[1] : '14333');

    updateState.status = 'succeeded';
    updateState.current_version = requestedVersion;
    updateState.message = `已经更新到 ${requestedVersion}，旧版已保留，可随时回退。`;
    updateState.finished_at = new Date().toISOString();
  } catch (error) {
    if (oldRenamed) {
      try {
        await rollbackUpdate(backupName, newContainerCreated);
        updateState.message = `更新没有完成，已自动恢复旧版：${friendlyUpdaterError(error)}`;
      } catch (_rollbackError) {
        updateState.message = '更新和自动恢复都没有完成，请查看更新服务日志。';
      }
    } else {
      updateState.message = `更新没有开始：${friendlyUpdaterError(error)}`;
    }
    updateState.status = 'failed';
    updateState.finished_at = new Date().toISOString();
  } finally {
    updateRunning = false;
  }
}

function friendlyUpdaterError(error) {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function pruneNonces(now = Date.now()) {
  for (const [nonce, createdAt] of usedNonces) {
    if (now - createdAt > 60_000) usedNonces.delete(nonce);
  }
}

function sendJson(response, statusCode, body) {
  const raw = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(raw),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(raw);
}

function handleRpc(request, response) {
  if (request.method !== 'POST' || request.url !== '/rpc') {
    sendJson(response, 404, { message: '接口不存在。' });
    return;
  }

  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > 16 * 1024) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (size > 16 * 1024) return;
    const body = Buffer.concat(chunks).toString('utf8');
    const timestamp = String(request.headers['x-updater-timestamp'] || '');
    const nonce = String(request.headers['x-updater-nonce'] || '');
    const signature = String(request.headers['x-updater-signature'] || '');
    pruneNonces();
    if (usedNonces.has(nonce) || !verifyUpdateRequest({ secret: SHARED_SECRET, timestamp, nonce, body, signature })) {
      sendJson(response, 403, { message: '更新请求验证失败。' });
      return;
    }
    usedNonces.set(nonce, Date.now());

    let command;
    try { command = JSON.parse(body); } catch (_error) {
      sendJson(response, 400, { message: '更新请求格式不正确。' });
      return;
    }
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      sendJson(response, 400, { message: '更新请求格式不正确。' });
      return;
    }
    if (command.action === 'status') {
      sendJson(response, 200, { enabled: true, ...updateState });
      return;
    }
    if (command.action !== 'update' || !isAllowedVersion(command.version)) {
      sendJson(response, 400, { message: '更新版本格式不正确。' });
      return;
    }
    if (updateRunning) {
      sendJson(response, 409, { message: '更新正在进行，请不要重复操作。', ...updateState });
      return;
    }
    sendJson(response, 202, {
      accepted: true,
      status: 'checking',
      message: `已开始更新到 ${command.version}。`,
      target_version: command.version,
    });
    setImmediate(() => performUpdate(command.version));
  });
}

function startUpdaterServer() {
  if (process.platform === 'win32') throw new Error('一键更新服务需要在 Linux 路由器上运行。');
  if (!validateSharedSecret(SHARED_SECRET)) throw new Error('UPDATER_SHARED_SECRET 至少需要 32 个字节。');
  if (!fs.existsSync(DOCKER_SOCKET_PATH) || !fs.statSync(DOCKER_SOCKET_PATH).isSocket()) {
    throw new Error('未找到 Docker 管理接口。');
  }

  const socketDirectory = path.dirname(UPDATER_SOCKET_PATH);
  fs.mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(socketDirectory, 0o700);
  if (fs.existsSync(UPDATER_SOCKET_PATH)) {
    const existing = fs.lstatSync(UPDATER_SOCKET_PATH);
    if (!existing.isSocket()) throw new Error('更新通信路径被其他文件占用。');
    fs.unlinkSync(UPDATER_SOCKET_PATH);
  }

  const server = http.createServer(handleRpc);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(UPDATER_SOCKET_PATH, () => {
    fs.chmodSync(UPDATER_SOCKET_PATH, 0o660);
    console.log('UPDATER: 一键更新服务已启动。');
  });
  return server;
}

if (require.main === module) startUpdaterServer();

module.exports = {
  buildContainerCreateConfig,
  compactTimestamp,
  isAllowedVersion,
  isNewerVersion,
  readContainerVersion,
  startUpdaterServer,
};
