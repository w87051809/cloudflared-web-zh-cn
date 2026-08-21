/**
 * Cloudflared process wrapper.
 * Original implementation based on code by Louis Lam under the MIT License.
 */

const childProcess = require('node:child_process');
const commandExistsSync = require('command-exists').sync;

class CloudflaredTunnel {
  constructor(cloudflaredPath = 'cloudflared') {
    this.cloudflaredPath = cloudflaredPath;
    this.childProcess = null;
    this.lastError = '';
  }

  get token() {
    return this._token;
  }

  set token(value) {
    const text = String(value || '').trim();
    const parts = text.split(/\s+/);
    this._token = parts.length > 1 ? parts[parts.length - 1] : text;
  }

  isRunning() {
    return Boolean(this.childProcess && this.childProcess.exitCode === null && !this.childProcess.killed);
  }

  start(additionalArgs = {}) {
    if (this.isRunning()) throw new Error('Already started');
    if (!commandExistsSync(this.cloudflaredPath)) {
      throw new Error(`Cloudflared error: ${this.cloudflaredPath} is not found`);
    }
    if (!this.token) throw new Error('Cloudflared error: Token is not set');

    const args = ['tunnel', '--no-autoupdate'];
    if (additionalArgs.configPath) args.push('--config', additionalArgs.configPath);
    if (additionalArgs.metrics) args.push('--metrics', `0.0.0.0:${additionalArgs.metrics}`);
    if (additionalArgs.edgeIpVersion) args.push('--edge-ip-version', additionalArgs.edgeIpVersion);
    if (additionalArgs.edgeBindAddress) args.push('--edge-bind-address', additionalArgs.edgeBindAddress);
    if (additionalArgs.gracePeriod) args.push('--grace-period', additionalArgs.gracePeriod);
    if (additionalArgs.region) args.push('--region', additionalArgs.region);
    if (additionalArgs.retries) args.push('--retries', additionalArgs.retries);
    if (additionalArgs.protocol) args.push('--protocol', additionalArgs.protocol);
    args.push('run', '--token', this.token);

    const safeArgs = [...args];
    safeArgs[safeArgs.length - 1] = '[REDACTED]';
    console.log('TUNNEL: 启动 cloudflared', safeArgs.join(' '));

    this.lastError = '';
    this.childProcess = childProcess.spawn(this.cloudflaredPath, args);
    this.childProcess.stdout.pipe(process.stdout);
    this.childProcess.stderr.pipe(process.stderr);

    this.childProcess.on('close', code => {
      console.log(`TUNNEL: cloudflared 已退出，代码 ${code}`);
      this.childProcess = null;
    });

    this.childProcess.on('error', error => {
      this.lastError = error.message;
      console.error(`TUNNEL: ${error.message}`);
    });

    this.childProcess.stderr.on('data', data => {
      const message = data.toString();
      if (!/\s(INF|WRN)\s/g.test(message)) this.lastError = message.trim();
    });
  }

  stop() {
    if (!this.childProcess) return;
    console.log('TUNNEL: 正在停止 cloudflared');
    this.childProcess.kill('SIGINT');
  }
}

module.exports = { CloudflaredTunnel };
