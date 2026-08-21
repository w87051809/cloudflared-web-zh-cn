const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('认证门禁、同源校验、会话吊销和私密文件权限', async () => {
  const port = await findFreePort();
  const configDir = path.join(os.tmpdir(), `cloudflared-web-security-${process.pid}-${Date.now()}`);
  fs.mkdirSync(configDir, { mode: 0o700 });
  const child = spawn(process.execPath, ['app.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      CONFIG_DIR: configDir,
      WEBUI_HOST: '127.0.0.1',
      WEBUI_PORT: String(port),
      WEBUI_SESSION_SECRET: 'test-session-secret-0123456789-abcdef',
      BASIC_AUTH_USER: 'admin',
      BASIC_AUTH_PASS: '123456789',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilReady(baseUrl, child);

    const status = await fetch(`${baseUrl}/auth/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('x-powered-by'), null);
    assert.match(status.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    assert.equal(status.headers.get('x-frame-options'), 'DENY');
    assert.equal(status.headers.get('cache-control'), 'no-store');

    const remoteDefaultLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.20',
      },
      body: JSON.stringify({ username: 'admin', password: '123456789' }),
    });
    assert.equal(remoteDefaultLogin.status, 403);

    const emptyJson = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    assert.equal(emptyJson.status, 400);

    const malformed = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.doesNotMatch(await malformed.text(), /app\.js|SyntaxError|<pre>/i);

    const login = await postJson(`${baseUrl}/auth/login`, {
      username: 'admin',
      password: '123456789',
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.body.must_change_credentials, true);
    const defaultCookie = readCookie(login.response);

    const lockedConfig = await fetch(`${baseUrl}/config`, {
      headers: { Cookie: defaultCookie },
    });
    assert.equal(lockedConfig.status, 428);
    assert.equal((await lockedConfig.json()).code, 'CREDENTIAL_CHANGE_REQUIRED');

    const formPost = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: {
        Cookie: defaultCookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'token=test',
    });
    assert.equal(formPost.status, 415);

    const crossOrigin = await fetch(`${baseUrl}/auth/credentials`, {
      method: 'POST',
      headers: {
        Cookie: defaultCookie,
        'Content-Type': 'application/json',
        Origin: 'http://untrusted.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);

    const reusedDefaultPassword = await postJson(`${baseUrl}/auth/credentials`, {
      current_password: '123456789',
      username: 'renamed-admin',
      password: '123456789',
    }, defaultCookie);
    assert.equal(reusedDefaultPassword.response.status, 400);

    const changed = await postJson(`${baseUrl}/auth/credentials`, {
      current_password: '123456789',
      username: 'secure-admin',
      password: 'Secure-Test-Password-2026',
    }, defaultCookie);
    assert.equal(changed.response.status, 200);
    assert.equal(changed.body.default_credentials, false);
    const secureCookie = readCookie(changed.response);

    const oldSession = await fetch(`${baseUrl}/config`, {
      headers: { Cookie: defaultCookie },
    });
    assert.equal(oldSession.status, 401);

    const unlockedConfig = await fetch(`${baseUrl}/config`, {
      headers: { Cookie: secureCookie },
    });
    assert.equal(unlockedConfig.status, 200);

    const uppercaseRoute = await fetch(`${baseUrl}/CONFIG`, {
      headers: { Cookie: secureCookie },
    });
    assert.equal(uppercaseRoute.status, 404);
    assert.equal(uppercaseRoute.headers.get('cache-control'), 'no-store');

    const savedToken = await postJson(`${baseUrl}/token`, { token: 'test-token' }, secureCookie);
    assert.equal(savedToken.response.status, 200);

    const authText = fs.readFileSync(path.join(configDir, 'auth.json'), 'utf8');
    assert.doesNotMatch(authText, /Secure-Test-Password-2026/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(configDir, 'auth.json')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(configDir, 'config.json')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
    }

    const logout = await postJson(`${baseUrl}/auth/logout`, {}, secureCookie);
    assert.equal(logout.response.status, 200);
    const revokedSession = await fetch(`${baseUrl}/config`, {
      headers: { Cookie: secureCookie },
    });
    assert.equal(revokedSession.status, 401);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
});

async function postJson(url, body, cookie = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : {},
  };
}

function readCookie(response) {
  const header = response.headers.get('set-cookie') || '';
  assert.match(header, /^cloudflared_web_session=/);
  return header.split(';', 1)[0];
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilReady(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出，代码 ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/auth/status`);
      if (response.ok) return;
    } catch (_error) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('等待测试服务启动超时。');
}
