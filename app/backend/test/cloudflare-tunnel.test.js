const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTunnelArgs } = require('../cloudflare-tunnel.js');

test('不覆盖 cloudflared 内置的四条容灾连接', () => {
  const args = buildTunnelArgs({ protocol: 'http2' }, 'test-token');
  assert.deepEqual(args, [
    'tunnel',
    '--no-autoupdate',
    '--protocol',
    'http2',
    'run',
    '--token',
    'test-token',
  ]);
  assert.equal(args.includes('--ha-connections'), false);
});
