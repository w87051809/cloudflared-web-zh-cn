const express = require('express');
const bodyParser = require('body-parser');
const basicAuth = require('express-basic-auth');
const fs = require('node:fs');
const path = require('node:path');
const tmp = require('tmp');
const { execSync } = require('node:child_process');

const { CloudflaredTunnel } = require('./cloudflare-tunnel.js');

const app = express();
const tunnel = new CloudflaredTunnel();
const port = process.env.WEBUI_PORT || 14333;
const host = process.env.WEBUI_HOST || '0.0.0.0';
const configpath = '/config/config.json';
const cloudflaredconfigdir = '/root/.cloudflared';
const cloudflaredconfigpath = `${cloudflaredconfigdir}/config.yml`;
const viewpath = path.normalize(__dirname + '/../frontend/dist');

app.use(bodyParser.json({ limit: '64kb' }));
app.use(bodyParser.urlencoded({ extended: false, limit: '64kb' }));

if (process.env.BASIC_AUTH_PASS) {
  const user = process.env.BASIC_AUTH_USER || 'admin';
  app.use(basicAuth({ users: { [user]: process.env.BASIC_AUTH_PASS }, challenge: true }));
}

app.use(express.static(viewpath));

app.get('/', (req, res) => {
  res.sendFile(path.join(viewpath, 'index.html'));
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
    const version = execSync('cloudflared -v', { encoding: 'utf8' });
    res.status(200).type('text/plain').send(version);
  } catch (error) {
    res.status(500).type('text/plain').send('无法读取 cloudflared 版本。');
  }
});

app.get('/new-version', async (req, res) => {
  const currentVersion = process.env.VERSION || 'unknown';
  let latestVersion = currentVersion;
  try {
    const response = await fetch('https://registry.hub.docker.com/v2/repositories/wisdomsky/cloudflared-web/tags/?page_size=100&page=1');
    const imageInfo = await response.json();
    const tags = (imageInfo.results || []).filter(tag => tag.name !== 'latest');
    latestVersion = tags[0]?.name || currentVersion;
  } catch (error) {
    console.warn('VERSION: 无法读取远程版本，继续使用当前版本。');
  }
  res.status(200).json({
    current_version: currentVersion,
    latest_version: latestVersion,
    update: currentVersion !== 'unknown' && currentVersion !== latestVersion,
  });
});

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

  const token = normalizeToken(req.body.token);
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
  const tempFile = tmp.fileSync();
  const yaml = String(req.body.yaml || '');
  fs.writeFileSync(tempFile.name, yaml);

  try {
    if (yaml.trim()) {
      execSync(`cloudflared --config "${tempFile.name}" tunnel ingress validate`);
    }
    if (!fs.existsSync(cloudflaredconfigdir)) {
      fs.mkdirSync(cloudflaredconfigdir, { recursive: true });
    }
    fs.writeFileSync(cloudflaredconfigpath, yaml);
    tempFile.removeCallback();
    return res.status(200).type('text/plain').send('配置已经保存。');
  } catch (error) {
    tempFile.removeCallback();
    const message = String(error.message || error).split('\n').slice(1).join('\n');
    return res.status(400).type('text/plain').send(message || '配置检查失败。');
  }
});

app.listen(port, host, () => {
  console.log('STATUS: 中文管理界面已启动');
  console.log(`WEBUI: http://${host}:${port}`);
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
    return { ...emptyConfig, ...JSON.parse(fs.readFileSync(configpath, 'utf8')) };
  } catch (error) {
    return emptyConfig;
  }
}

function saveConfig(config) {
  const directory = path.dirname(configpath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(configpath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
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
  if (fs.existsSync(cloudflaredconfigpath)) additionalArgs.configPath = cloudflaredconfigpath;

  tunnel.start(additionalArgs);
  console.log('STATUS: 隧道启动命令已发送');
}

function friendlyError(error) {
  const message = String(error?.message || error || '未知错误');
  if (message.includes('Token is not set')) return '没有找到隧道连接令牌。';
  if (message.includes('is not found')) return '容器里没有找到 cloudflared 程序。';
  if (message.includes('Already started')) return '隧道已经在运行。';
  return message;
}
