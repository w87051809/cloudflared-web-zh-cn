const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTunnelArgs, normalizeHaConnections } = require('../cloudflare-tunnel.js');

test('默认部署只建立一条 Cloudflare 边缘连接', () => {
  const args = buildTunnelArgs({ protocol: 'http2', haConnections: '1' }, 'test-token');
  assert.deepEqual(args, [
    'tunnel',
    '--no-autoupdate',
    '--protocol',
    'http2',
    '--ha-connections',
    '1',
    'run',
    '--token',
    'test-token',
  ]);
  assert.ok(args.indexOf('--ha-connections') < args.indexOf('run'));
});

test('边缘连接数只接受 cloudflared 支持的范围', () => {
  assert.equal(normalizeHaConnections('1'), '1');
  assert.equal(normalizeHaConnections(4), '4');
  assert.throws(() => normalizeHaConnections('0'), /1 至 4/);
  assert.throws(() => normalizeHaConnections('5'), /1 至 4/);
  assert.throws(() => normalizeHaConnections('1 --protocol quic'), /1 至 4/);
});
