const express = require('express');
const { rateLimit } = require('express-rate-limit');
const fs = require('node:fs');
const { isIP } = require('node:net');
const path = require('node:path');
const tmp = require('tmp');
const { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { CloudflaredTunnel } = require('./cloudflare-tunnel.js');
const { callUpdater, isUpdaterConfigured } = require('./updater-client.js');

const app = express();
const cloudflaredPath = process.env.CLOUDFLARED_BIN || (process.platform === 'win32' ? 'cloudflared' : '/usr/local/bin/cloudflared');
const tunnel = new CloudflaredTunnel(cloudflaredPath);
const port = process.env.WEBUI_PORT || 14333;
const host = process.env.WEBUI_HOST || '0.0.0.0';
const configdir = process.env.CONFIG_DIR || '/config';
const configpath = path.join(configdir, 'config.json');
const authConfigPath = path.join(configdir, 'auth.json');
const cloudflaredconfigdir = '/root/.cloudflared';
const cloudflaredconfigpath = `${cloudflaredconfigdir}/config.yml`;
const viewpath = path.normalize(__dirname + '/../frontend/dist');
const appVersion = String(process.env.APP_VERSION || require('./package.json').version);
const defaultAuthUser = 'admin';
const defaultAuthPassword = '123456789';
const initialAuthUser = String(process.env.BASIC_AUTH_USER || defaultAuthUser);
const initialAuthPassword = String(process.env.BASIC_AUTH_PASS || defaultAuthPassword);
if (!isValidUsername(initialAuthUser)) {
  throw new Error('BASIC_AUTH_USER 需要使用 3 至 64 个字符，不能包含空格。');
}
if (initialAuthPassword.length < 8 || initialAuthPassword.length > 128) {
  throw new Error('BASIC_AUTH_PASS 需要使用 8 至 128 个字符。');
}
const authCookieName = 'cloudflared_web_session';
const authSessionHours = clampNumber(process.env.WEBUI_SESSION_HOURS, 12, 1, 168);
const authSessionSeconds = authSessionHours * 60 * 60;
const configuredAuthSecret = String(process.env.WEBUI_SESSION_SECRET || '');
if (configuredAuthSecret && Buffer.byteLength(configuredAuthSecret, 'utf8') < 32) {
  throw new Error('WEBUI_SESSION_SECRET 至少需要 32 个字节。');
}
const authSecret = Buffer.from(configuredAuthSecret || randomBytes(32).toString('hex'), 'utf8');
const failedLogins = new Map();
const activeSessions = new Map();
const maxLoginAttempts = 5;
const loginBlockMs = 5 * 60 * 1000;
const maxPasswordChecks = 8;
let activePasswordChecks = 0;
let latestVersionCache = { value: '', expiresAt: 0 };
let authConfig = loadAuthConfig();
let defaultCredentialsActive = detectDefaultCredentials(authConfig);
hardenExistingPrivateFiles();

if (process.env.WEBUI_TRUST_PROXY === 'true') app.set('trust proxy', 'loopback');
app.set('case sensitive routing', true);
app.disable('x-powered-by');
app.use(addSecurityHeaders);
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: '请求过于频繁，请稍后重试。' },
}));
app.use(requireSafeMutationRequest);
app.use(express.json({ limit: '64kb' }));
app.use(requireJsonObjectBody);

app.get('/auth/status', (req, res) => {
  const authenticated = isAuthenticated(req);
  res.status(200).json({
    enabled: true,
    authenticated,
    must_change_credentials: authenticated && usesDefaultCredentials(),
  });
});

app.post('/auth/login', asyncRoute(async (req, res) => {
  if (typeof req.body.username !== 'string' || typeof req.body.password !== 'string') {
    return res.status(400).json({ message: '请填写管理账号和登录密码。' });
  }
  if (usesDefaultCredentials() && !isTrustedSetupRequest(req)) {
    return res.status(403).json({ message: '默认登录信息只能在可信局域网内首次修改。' });
  }
  const clientKey = getClientKey(req);
  const now = Date.now();
  let loginState = failedLogins.get(clientKey);
  if (loginState?.blockedUntil && loginState.blockedUntil <= now) {
    failedLogins.delete(clientKey);
    loginState = undefined;
  }
  if (loginState?.blockedUntil > now) {
    const retryAfter = Math.ceil((loginState.blockedUntil - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ message: `登录失败次数过多，请在 ${retryAfter} 秒后重试。` });
  }

  const username = String(req.body.username || '').slice(0, 200);
  const password = String(req.body.password || '').slice(0, 500);
  if (activePasswordChecks >= maxPasswordChecks) {
    res.setHeader('Retry-After', '1');
    return res.status(429).json({ message: '当前登录请求较多，请稍后重试。' });
  }
  const authSnapshot = authConfig;
  const usernameValid = safeEqual(username, authSnapshot.username);
  activePasswordChecks += 1;
  let passwordValid = false;
  try {
    passwordValid = await verifyPassword(password, authSnapshot);
  } finally {
    activePasswordChecks -= 1;
  }
  const credentialsValid = usernameValid
    && passwordValid
    && authConfig.revision === authSnapshot.revision;

  if (!credentialsValid) {
    const currentLoginState = failedLogins.get(clientKey);
    const attempts = (currentLoginState?.attempts || 0) + 1;
    failedLogins.set(clientKey, {
      attempts,
      blockedUntil: attempts >= maxLoginAttempts ? now + loginBlockMs : 0,
      updatedAt: now,
    });
    pruneLoginAttempts(now);
    const remaining = Math.max(0, maxLoginAttempts - attempts);
    return res.status(401).json({
      message: remaining > 0
        ? `账号或密码不正确，还可以尝试 ${remaining} 次。`
        : '登录失败次数过多，请在 5 分钟后重试。',
    });
  }

  failedLogins.delete(clientKey);
  setSessionCookie(req, res, createSessionToken(authConfig.username, authConfig.revision));
  console.log(`AUTH: 管理员已登录，来源 ${clientKey}`);
  return res.status(200).json({
    ok: true,
    authenticated: true,
    must_change_credentials: usesDefaultCredentials(),
  });
}));

app.post('/auth/logout', (req, res) => {
  const session = getAuthenticatedSession(req);
  if (session) activeSessions.delete(session.nonce);
  clearSessionCookie(req, res);
  return res.status(200).json({ ok: true });
});

app.use(express.static(viewpath));

app.get('/', (req, res) => {
  res.sendFile(path.join(viewpath, 'index.html'));
});

app.use((req, res, next) => {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ message: '请先登录后再操作。' });
});

app.get('/auth/profile', (req, res) => {
  res.status(200).json({
    username: authConfig.username,
    default_credentials: usesDefaultCredentials(),
  });
});

app.post('/auth/credentials', asyncRoute(async (req, res) => {
  if (
    typeof req.body.current_password !== 'string'
    || typeof req.body.username !== 'string'
    || typeof req.body.password !== 'string'
  ) {
    return res.status(400).json({ message: '请完整填写当前密码、新账号和新密码。' });
  }
  if (usesDefaultCredentials() && !isTrustedSetupRequest(req)) {
    return res.status(403).json({ message: '默认登录信息只能在可信局域网内首次修改。' });
  }
  const currentPassword = String(req.body.current_password || '').slice(0, 500);
  const username = String(req.body.username || '').trim().slice(0, 200);
  const password = String(req.body.password || '').slice(0, 500);

  if (activePasswordChecks >= maxPasswordChecks) {
    res.setHeader('Retry-After', '1');
    return res.status(429).json({ message: '当前密码校验请求较多，请稍后重试。' });
  }
  const authSnapshot = authConfig;
  activePasswordChecks += 1;
  let currentPasswordValid = false;
  try {
    currentPasswordValid = await verifyPassword(currentPassword, authSnapshot);
  } finally {
    activePasswordChecks -= 1;
  }
  if (!currentPasswordValid) {
    return res.status(403).json({ message: '当前密码不正确。' });
  }
  if (authConfig.revision !== authSnapshot.revision) {
    return res.status(409).json({ message: '登录信息刚刚发生变化，请刷新页面后重试。' });
  }
  if (!isValidUsername(username)) {
    return res.status(400).json({ message: '管理账号需要使用 3 至 64 个字符，不能包含空格。' });
  }
  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({ message: '新密码需要使用 8 至 128 个字符。' });
  }
  if (password === defaultAuthPassword) {
    return res.status(400).json({ message: '不能继续使用公开的默认密码，请设置新的密码。' });
  }

  const nextConfig = createAuthConfig(username, password);
  saveAuthConfig(nextConfig);
  authConfig = nextConfig;
  defaultCredentialsActive = false;
  failedLogins.clear();
  activeSessions.clear();
  setSessionCookie(req, res, createSessionToken(authConfig.username, authConfig.revision));
  console.log('AUTH: 管理登录信息已更新，旧登录会话已经失效。');
  return res.status(200).json({
    ok: true,
    username: authConfig.username,
    default_credentials: usesDefaultCredentials(),
  });
}));

app.use((req, res, next) => {
  if (!usesDefaultCredentials()) return next();
  return res.status(428).json({
    code: 'CREDENTIAL_CHANGE_REQUIRED',
    message: '首次登录后请先修改默认账号和密码。',
  });
});

app.get('/config', (req, res) => {
  const config = getConfig();
  res.status(200).json({
    token_set: Boolean(String(config.token || '').trim()),
    start: Boolean(config.start),
  });
});

app.get('/details', (req, res) => {
  const config = getConfig();
  res.status(200).json({
    running: tunnel.isRunning(),
    desired_start: Boolean(config.start),
    tunnel_id: parseTunnelId(config.token),
    protocol: process.env.PROTOCOL || 'auto',
    edge_ip_version: process.env.EDGE_IP_VERSION || 'auto',
    webui_port: String(port),
  });
});

app.get('/version', (req, res) => {
  try {
    const version = execFileSync(cloudflaredPath, ['-v'], { encoding: 'utf8', timeout: 5000 });
    res.status(200).type('text/plain').send(version);
  } catch (error) {
    res.status(500).type('text/plain').send('无法读取 cloudflared 版本。');
  }
});

app.get('/new-version', asyncRoute(async (req, res) => {
  const currentVersion = appVersion;
  let latestVersion = currentVersion;
  try {
    latestVersion = await getLatestAppVersion();
  } catch (error) {
    console.warn('VERSION: 无法读取远程版本，继续使用当前版本。');
  }
  const updateAvailable = isNewerAppVersion(latestVersion, currentVersion);
  if (!updateAvailable && latestVersion !== currentVersion) latestVersion = currentVersion;
  res.status(200).json({
    current_version: currentVersion,
    latest_version: latestVersion,
    update: updateAvailable,
  });
}));

app.get('/update/status', asyncRoute(async (req, res) => {
  if (!isUpdaterConfigured()) {
    return res.status(200).json({
      enabled: false,
      status: 'unavailable',
      message: '当前安装方式还没有启用一键更新服务。',
    });
  }
  try {
    return res.status(200).json(await callUpdater('status'));
  } catch (_error) {
    return res.status(200).json({
      enabled: false,
      status: 'unavailable',
      message: '一键更新服务暂时没有响应。',
    });
  }
}));

const updateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: '更新操作过于频繁，请稍后重试。' },
});

app.post('/update', updateLimiter, asyncRoute(async (req, res) => {
  if (!isUpdaterConfigured()) {
    return res.status(503).json({ message: '一键更新服务尚未安装。' });
  }

  let latestVersion;
  try {
    latestVersion = await getLatestAppVersion(true);
  } catch (_error) {
    return res.status(503).json({ message: '暂时无法核对仓库最新版本，请稍后重试。' });
  }
  if (!isNewerAppVersion(latestVersion, appVersion)) {
    return res.status(409).json({ message: '当前已经是最新版本。' });
  }

  try {
    const result = await callUpdater('update', { version: latestVersion });
    return res.status(202).json(result);
  } catch (error) {
    const statusCode = error?.statusCode === 409 ? 409 : 503;
    return res.status(statusCode).json({
      message: error instanceof Error ? error.message : '一键更新服务暂时不可用。',
    });
  }
}));

app.post('/start', (req, res) => {
  const start = req.body.start;
  if (typeof start !== 'boolean') {
    return res.status(400).json({ message: '启动状态格式不正确。' });
  }

  const config = getConfig();
  if (start && !String(config.token || '').trim()) {
    return res.status(400).json({ message: '请先保存隧道连接令牌。' });
  }

  config.start = start;
  saveConfig(config);

  try {
    init(config);
    return res.status(200).json({ ok: true, start });
  } catch (error) {
    config.start = false;
    saveConfig(config);
    return res.status(500).json({ message: friendlyError(error) });
  }
});

app.post('/token', (req, res) => {
  if (tunnel.isRunning()) {
    return res.status(409).json({ message: '隧道正在运行，请先停止后再修改令牌。' });
  }

  if (typeof req.body.token !== 'string') {
    return res.status(400).json({ message: '连接令牌格式不正确。' });
  }
  const rawToken = req.body.token;
  if (rawToken.length > 8192) {
    return res.status(413).json({ message: '连接令牌内容过长。' });
  }
  const token = normalizeToken(rawToken);
  if (!token) {
    return res.status(400).json({ message: '连接令牌不能为空。' });
  }

  const config = getConfig();
  config.token = token;
  saveConfig(config);
  console.log('CONFIG: 连接令牌已更新，日志中已隐藏令牌内容。');
  return res.status(200).json({ ok: true });
});

app.get('/advanced/config/local', (req, res) => {
  const content = fs.existsSync(cloudflaredconfigpath) ? fs.readFileSync(cloudflaredconfigpath) : '';
  res.status(200).type('text/plain').send(content);
});

app.post('/advanced/config/local', (req, res) => {
  if (typeof req.body.yaml !== 'string') {
    return res.status(400).type('text/plain').send('配置内容格式不正确。');
  }
  const yaml = req.body.yaml;
  const tempFile = tmp.fileSync({ mode: 0o600, discardDescriptor: true });

  try {
    fs.writeFileSync(tempFile.name, yaml, { mode: 0o600 });
    if (yaml.trim()) {
      execFileSync(
        cloudflaredPath,
        ['--config', tempFile.name, 'tunnel', 'ingress', 'validate'],
        { timeout: 10000, maxBuffer: 1024 * 1024 },
      );
    }
    if (!fs.existsSync(cloudflaredconfigdir)) {
      fs.mkdirSync(cloudflaredconfigdir, { recursive: true, mode: 0o700 });
    }
    savePrivateTextFile(cloudflaredconfigpath, yaml);
    return res.status(200).type('text/plain').send('配置已经保存。');
  } catch (error) {
    console.warn('CONFIG: cloudflared 配置检查未通过。');
    return res.status(400).type('text/plain').send('配置检查失败，请检查 YAML 格式和入口规则。');
  } finally {
    tempFile.removeCallback();
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ message: '提交内容过大。' });
  }
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return res.status(400).json({ message: '提交的数据格式不正确。' });
  }
  console.error(`WEBUI: 请求处理失败：${error?.message || '未知错误'}`);
  return res.status(500).json({ message: '管理服务处理请求失败。' });
});

app.listen(port, host, () => {
  console.log('STATUS: 中文管理界面已启动');
  console.log(`WEBUI: http://${host}:${port}`);
  console.log(`AUTH: 登录保护已开启，管理账号 ${authConfig.username}`);
  const config = getConfig();
  if (config.start) {
    setTimeout(() => {
      try {
        init(config);
      } catch (error) {
        console.error(`TUNNEL: ${friendlyError(error)}`);
      }
    }, 1200);
  }
});

function getConfig() {
  const emptyConfig = { token: '', start: false };
  try {
    const stored = JSON.parse(fs.readFileSync(configpath, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new Error('隧道配置文件格式不正确。');
    }
    fs.chmodSync(configpath, 0o600);
    return {
      token: String(stored.token || ''),
      start: Boolean(stored.start),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyConfig;
    throw new Error(`无法读取隧道配置：${error.message}`);
  }
}

function saveConfig(config) {
  savePrivateTextFile(configpath, JSON.stringify(config, null, 2) + '\n');
}

function normalizeToken(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parts = text.split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : text;
}

function parseTunnelId(token) {
  try {
    const parsed = JSON.parse(Buffer.from(normalizeToken(token), 'base64url').toString('utf8'));
    return typeof parsed.t === 'string' ? parsed.t : '';
  } catch (error) {
    return '';
  }
}

function init(config) {
  tunnel.token = config.token;
  if (!config.start) {
    tunnel.stop();
    console.log('STATUS: 隧道已停止');
    return;
  }

  const additionalArgs = {};
  if (process.env.METRICS_ENABLE === 'true') additionalArgs.metrics = process.env.METRICS_PORT;
  if (process.env.EDGE_BIND_ADDRESS) additionalArgs.edgeBindAddress = process.env.EDGE_BIND_ADDRESS;
  if (process.env.GRACE_PERIOD) additionalArgs.gracePeriod = process.env.GRACE_PERIOD;
  if (process.env.REGION) additionalArgs.region = process.env.REGION;
  if (process.env.RETRIES) additionalArgs.retries = process.env.RETRIES;
  if (process.env.EDGE_IP_VERSION) additionalArgs.edgeIpVersion = process.env.EDGE_IP_VERSION;
  if (process.env.PROTOCOL) additionalArgs.protocol = process.env.PROTOCOL;
  if (fs.existsSync(cloudflaredconfigpath)) {
    fs.chmodSync(cloudflaredconfigpath, 0o600);
    additionalArgs.configPath = cloudflaredconfigpath;
  }

  tunnel.start(additionalArgs);
  console.log('STATUS: 隧道启动命令已发送');
}

function friendlyError(error) {
  const message = String(error?.message || error || '未知错误');
  if (message.includes('Token is not set')) return '没有找到隧道连接令牌。';
  if (message.includes('is not found')) return '容器里没有找到 cloudflared 程序。';
  if (message.includes('Already started')) return '隧道已经在运行。';
  return '隧道操作失败，请查看容器日志。';
}

function loadAuthConfig() {
  try {
    const stored = JSON.parse(fs.readFileSync(authConfigPath, 'utf8'));
    if (
      stored.version !== 1
      || !isValidUsername(stored.username)
      || !/^[a-f0-9]{32}$/i.test(String(stored.passwordSalt || ''))
      || !/^[a-f0-9]{128}$/i.test(String(stored.passwordHash || ''))
      || !/^[a-f0-9]{32}$/i.test(String(stored.revision || ''))
    ) {
      throw new Error('登录配置文件格式不正确。');
    }
    fs.chmodSync(authConfigPath, 0o600);
    return stored;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`无法读取登录配置：${error.message}`);
    }
    const created = createAuthConfig(initialAuthUser, initialAuthPassword);
    saveAuthConfig(created);
    return created;
  }
}

function createAuthConfig(username, password) {
  const passwordSalt = randomBytes(16).toString('hex');
  return {
    version: 1,
    username,
    passwordSalt,
    passwordHash: scryptSync(password, passwordSalt, 64).toString('hex'),
    revision: randomBytes(16).toString('hex'),
    updatedAt: new Date().toISOString(),
  };
}

function saveAuthConfig(config) {
  savePrivateTextFile(authConfigPath, JSON.stringify(config, null, 2) + '\n');
}

function savePrivateTextFile(filePath, content) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function hardenExistingPrivateFiles() {
  const privateDirectories = [configdir, cloudflaredconfigdir];
  const privateFiles = [configpath, authConfigPath, cloudflaredconfigpath];
  for (const directory of privateDirectories) {
    if (fs.existsSync(directory)) fs.chmodSync(directory, 0o700);
  }
  for (const filePath of privateFiles) {
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  }
}

function verifyPassword(password, config) {
  return new Promise(resolve => {
    const expected = Buffer.from(config.passwordHash, 'hex');
    scrypt(String(password), config.passwordSalt, expected.length, (error, actual) => {
      resolve(!error && expected.length === actual.length && timingSafeEqual(expected, actual));
    });
  }).catch(() => false);
}

function detectDefaultCredentials(config) {
  if (config.username !== defaultAuthUser) return false;
  try {
    const expected = Buffer.from(config.passwordHash, 'hex');
    const actual = scryptSync(defaultAuthPassword, config.passwordSalt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch (_error) {
    return false;
  }
}

function usesDefaultCredentials() {
  return defaultCredentialsActive;
}

async function getLatestAppVersion(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && latestVersionCache.value && latestVersionCache.expiresAt > now) {
    return latestVersionCache.value;
  }
  const response = await fetch(
    'https://api.github.com/repos/w87051809/cloudflared-web-zh-cn/releases/latest',
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cloudflared-web-zh-cn',
      },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error(`远程版本接口返回 ${response.status}`);
  const release = await response.json();
  const latestVersion = String(release.tag_name || '').replace(/^v/, '');
  if (release.draft || release.prerelease || !/^\d+\.\d+\.\d+-zh-cn\.\d+$/.test(latestVersion)) {
    throw new Error('远程版本内容不完整。');
  }
  latestVersionCache = { value: latestVersion, expiresAt: now + 10 * 60 * 1000 };
  return latestVersion;
}

function isNewerAppVersion(candidate, current) {
  const parse = value => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)-zh-cn\.(\d+)$/);
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

function isValidUsername(username) {
  return typeof username === 'string'
    && username.length >= 3
    && username.length <= 64
    && !/[\s\x00-\x1f\x7f]/.test(username);
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function getClientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function pruneLoginAttempts(now) {
  const staleBefore = now - loginBlockMs * 2;
  for (const [key, state] of failedLogins) {
    if (state.updatedAt < staleBefore) failedLogins.delete(key);
  }
  if (failedLogins.size <= 2048) return;
  const overflow = failedLogins.size - 2048;
  for (const key of Array.from(failedLogins.keys()).slice(0, overflow)) {
    failedLogins.delete(key);
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map(item => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const separator = item.indexOf('=');
      if (separator === -1) return cookies;
      const name = item.slice(0, separator);
      const value = item.slice(separator + 1);
      try {
        cookies[name] = decodeURIComponent(value);
      } catch (_error) {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function createSessionToken(username, revision) {
  const session = {
    username,
    revision,
    expiresAt: Date.now() + authSessionSeconds * 1000,
    nonce: randomBytes(16).toString('hex'),
  };
  activeSessions.set(session.nonce, session);
  pruneActiveSessions();
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = createHmac('sha256', authSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!payload || !signature) return false;
    const expected = createHmac('sha256', authSecret).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const activeSession = activeSessions.get(session.nonce);
    if (!activeSession) return null;
    const valid = /^[a-f0-9]{32}$/i.test(String(session.nonce || ''))
      && session.username === authConfig.username
      && session.revision === authConfig.revision
      && Number(session.expiresAt) === Number(activeSession.expiresAt)
      && Number(session.expiresAt) > Date.now();
    if (!valid) activeSessions.delete(session.nonce);
    return valid ? session : null;
  } catch (_error) {
    return null;
  }
}

function isAuthenticated(req) {
  return Boolean(getAuthenticatedSession(req));
}

function getAuthenticatedSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[authCookieName]);
}

function pruneActiveSessions() {
  const now = Date.now();
  for (const [nonce, session] of activeSessions) {
    if (Number(session.expiresAt) <= now) activeSessions.delete(nonce);
  }
  if (activeSessions.size <= 2048) return;
  const overflow = activeSessions.size - 2048;
  for (const nonce of Array.from(activeSessions.keys()).slice(0, overflow)) {
    activeSessions.delete(nonce);
  }
}

function addSecurityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (/^\/(auth|config|details|version|new-version|update|start|token|advanced)(\/|$)/.test(req.path.toLowerCase())) {
    res.setHeader('Cache-Control', 'no-store');
  }
  if (shouldUseSecureCookie(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
}

function requireSafeMutationRequest(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!req.is('application/json')) {
    return res.status(415).json({ message: '管理接口只接受 JSON 格式的数据。' });
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return res.status(403).json({ message: '请求来源不受信任。' });
  }
  const origin = String(req.headers.origin || '');
  if (origin && !isAllowedOrigin(req, origin)) {
    return res.status(403).json({ message: '请求来源不受信任。' });
  }
  return next();
}

function requireJsonObjectBody(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ message: '请提交有效的 JSON 对象。' });
  }
  return next();
}

function isTrustedSetupRequest(req) {
  if (process.env.WEBUI_ALLOW_REMOTE_SETUP === 'true') return true;
  const cloudflareClientIp = String(req.headers['cf-connecting-ip'] || '').split(',')[0].trim();
  const peerIp = String(req.socket?.remoteAddress || '');
  const forwardedHeadersPresent = Boolean(
    req.headers['x-forwarded-for']
    || req.headers.forwarded,
  );
  if (isLoopbackIp(peerIp)) {
    if (cloudflareClientIp) return isPrivateOrLoopbackIp(cloudflareClientIp);
    if (process.env.WEBUI_TRUST_PROXY === 'true') {
      return isPrivateOrLoopbackIp(req.ip || peerIp);
    }
    return !forwardedHeadersPresent;
  }
  if (cloudflareClientIp || forwardedHeadersPresent) return false;
  return isPrivateOrLoopbackIp(req.ip || peerIp);
}

function isLoopbackIp(value) {
  let ip = String(value || '').trim().toLowerCase().split('%')[0];
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip === '::1' || ip.startsWith('127.');
}

function isPrivateOrLoopbackIp(value) {
  let ip = String(value || '').trim().toLowerCase().split('%')[0];
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const ipVersion = isIP(ip);
  if (!ipVersion) return false;
  if (ip === '::1') return true;
  if (ipVersion === 4) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || parts[0] === 192 && parts[1] === 168
      || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
      || parts[0] === 169 && parts[1] === 254;
  }
  const firstHextet = Number.parseInt(ip.split(':')[0], 16);
  return Number.isFinite(firstHextet)
    && ((firstHextet & 0xfe00) === 0xfc00 || (firstHextet & 0xffc0) === 0xfe80);
}

function isAllowedOrigin(req, origin) {
  try {
    const parsed = new URL(origin);
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const protocols = new Set([String(req.protocol || 'http').toLowerCase()]);
    const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (forwardedProtocol) protocols.add(forwardedProtocol);
    return parsed.host.toLowerCase() === hostHeader
      && protocols.has(parsed.protocol.replace(':', '').toLowerCase());
  } catch (_error) {
    return false;
  }
}

function shouldUseSecureCookie(req) {
  if (process.env.WEBUI_COOKIE_SECURE === 'true') return true;
  if (process.env.WEBUI_COOKIE_SECURE === 'false') return false;
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token) {
  const attributes = [
    `${authCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${authSessionSeconds}`,
  ];
  if (shouldUseSecureCookie(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(req, res) {
  const attributes = [
    `${authCookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (shouldUseSecureCookie(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}
