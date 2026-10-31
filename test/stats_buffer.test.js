// Aggregated stats/traffic Redis writes: many increments become one APPEND per key per flush,
// report reads include deltas not yet flushed, and a failed flush is retried instead of dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

process.env.UPSTASH_REDIS_REST_URL = 'https://example.test/redis';
process.env.UPSTASH_REDIS_REST_TOKEN = 'unit-test-token';

const hashes = new Map();
const strings = new Map();
const calls = [];
let failAppends = 0;
let fetchThrows = false;

function reply(result) {
  return { ok: true, json: async () => ({ result }) };
}
globalThis.fetch = async (_url, opts) => {
  if (fetchThrows) throw new Error('redis down');
  const cmd = JSON.parse(opts.body);
  const op = String(cmd[0]).toUpperCase();
  calls.push(op + ' ' + cmd[1]);
  if (op === 'APPEND' && failAppends > 0) {
    failAppends -= 1;
    throw new Error('redis down');
  }
  if (op === 'HGETALL') {
    const h = hashes.get(cmd[1]);
    if (!h) return reply([]);
    const flat = [];
    for (const [k, v] of h) flat.push(k, String(v));
    return reply(flat);
  }
  if (op === 'GET') return reply(strings.has(cmd[1]) ? strings.get(cmd[1]) : null);
  if (op === 'APPEND') {
    const prev = strings.get(cmd[1]) || '';
    const next = prev + String(cmd[2]);
    strings.set(cmd[1], next);
    return reply(next.length);
  }
  if (op === 'EXPIRE') return reply(1);
  return reply(null);
};

const stats = await import('../stats.js');

function linesOf(keyPrefix) {
  const out = [];
  for (const [key, value] of strings) {
    if (!key.startsWith(keyPrefix)) continue;
    for (const line of String(value).split('\n')) {
      if (!line.startsWith('{')) continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}
function coinQuotes(report) {
  const row = report.routes.find(r => r.route === 'GET /api/coin/:symbol');
  return row ? row.quotes : 0;
}

test('stats counters aggregate to one command per key and stay visible before flush', async () => {
  assert.equal(stats.STATS_FLUSH_MS, 5 * 60 * 1000);
  stats._resetTrafficForTests();
  const day = stats.mtDate();
  const utc = stats.utcDate();
  hashes.set('gw8:stats:' + day, new Map([['GET /api/coin/:symbol|402', 7]]));
  strings.set('gw8:stats:buf:' + day, 'NOTJSON\n{"GET /api/coin/:symbol|402":2}\n');

  const ip = stats.hashIp('203.0.113.40');
  for (let i = 0; i < 4; i++) {
    stats.record('GET', '/api/coin/BTC', 402);
    await stats.recordAudience({ route: 'GET /api/coin/:symbol', statusCode: 402, ua: 'x402scan/1.0', paidRoute: true, ipHash: ip });
  }
  stats.record('GET', '/', 200);
  stats.record('GET', '/.env', 404);
  stats.record('GET', '/.env', 404);
  assert.equal(calls.length, 0);

  const before = await stats.getStats(1);
  assert.equal(coinQuotes(before), 13);
  assert.equal(before.meta.homeKeepWarm.requests, 1);
  assert.equal(before.routes.some(r => r.route === 'GET /'), false);
  assert.equal(before.audience.bot.quotes, 4);
  assert.equal(before.audience.topBots.find(b => b.name === 'x402scan').requests, 4);
  assert.equal(JSON.stringify(before).includes('203.0.113.40'), false);

  const trafficBefore = await stats.getTrafficReport(1);
  const coin = trafficBefore.sinceBoot.routes.find(r => r.route === 'GET /api/coin/:symbol');
  assert.equal(coin.byStatus['402'], 4);
  assert.equal(trafficBefore.daily.find(d => d.date === utc).byStatus['402'], 4);
  assert.equal(trafficBefore.sinceBoot.unmatchedProbes.find(p => p.path === '/.env').count, 2);

  const flushed = await stats.flushStatsNow();
  assert.equal(flushed.commands, 4);
  const statsLines = linesOf('gw8:stats:buf:');
  assert.equal(statsLines.length, 2);
  assert.equal(statsLines[1]['GET /api/coin/:symbol|402'], 4);
  assert.equal(statsLines[1]['GET /|2xx'], 1);
  assert.equal(statsLines[1]['a|bot|402|GET /api/coin/:symbol'], 4);
  assert.equal(statsLines[1]['ua|x402scan'], 4);
  assert.equal(statsLines[1]['ih|' + ip + '|q'], 4);
  const trafficLines = linesOf('gw8:traffic:v1:buf:');
  assert.equal(trafficLines.length, 1);
  assert.equal(trafficLines[0]['r|GET /api/coin/:symbol|402'], 4);
  assert.equal(trafficLines[0]['s|x402|402'], 4);
  assert.equal(trafficLines[0]['p|' + encodeURIComponent('/.env')], 2);
  assert.equal(calls.filter(c => c.startsWith('HINCRBY')).length, 0);
  assert.equal(calls.filter(c => c.startsWith('EXPIRE')).length, 2);

  const after = await stats.getStats(1);
  assert.equal(coinQuotes(after), 13);
  const trafficAfter = await stats.getTrafficReport(1);
  assert.equal(trafficAfter.daily.find(d => d.date === utc).byStatus['402'], 4);
  assert.equal(trafficAfter.sinceBoot.unmatchedProbes.find(p => p.path === '/.env').count, 2);

  for (let i = 0; i < 4; i++) stats.record('GET', '/api/coin/ETH', 402);
  await stats.flushStatsNow();
  assert.equal(linesOf('gw8:stats:buf:').length, 3);
  assert.equal(linesOf('gw8:stats:buf:')[2]['GET /api/coin/:symbol|402'], 4);
  assert.equal(calls.filter(c => c.startsWith('EXPIRE')).length, 2);
  assert.equal(coinQuotes(await stats.getStats(1)), 17);

  failAppends = 1;
  stats.record('GET', '/api/coin/SOL', 402);
  stats.record('GET', '/api/coin/SOL', 402);
  await stats.flushStatsNow();
  assert.equal(coinQuotes(await stats.getStats(1)), 19);
  const midTraffic = await stats.getTrafficReport(1);
  assert.equal(midTraffic.daily.find(d => d.date === utc).byStatus['402'], 10);
  await stats.flushStatsNow();
  assert.equal(coinQuotes(await stats.getStats(1)), 19);
  assert.equal((await stats.getTrafficReport(1)).daily.find(d => d.date === utc).byStatus['402'], 10);
  const trafficObjs = linesOf('gw8:traffic:v1:buf:');
  assert.equal(trafficObjs.length, 3);
  assert.equal(trafficObjs.reduce((s, o) => s + (o['r|GET /api/coin/:symbol|402'] || 0), 0), 10);

  fetchThrows = true;
  assert.doesNotThrow(() => stats.record('GET', '/api/coin/XRP', 402));
  await stats.flushStatsNow();
  const fallback = await stats.getStats(1);
  assert.equal(coinQuotes(fallback), 11);
  assert.equal(fallback.store, 'upstash-redis');
});

test('SIGTERM flushes once per key before the process exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw8-stats-'));
  const ready = path.join(dir, 'ready');
  const log = path.join(dir, 'log');
  const script = `
    import fs from 'fs';
    globalThis.fetch = async (_u, opts) => {
      const cmd = JSON.parse(opts.body);
      fs.appendFileSync(process.env.LOG_FILE, cmd[0] + ' ' + cmd[1] + '\\n');
      const op = String(cmd[0]).toUpperCase();
      const result = op === 'HGETALL' ? [] : op === 'APPEND' || op === 'EXPIRE' ? 1 : null;
      return { ok: true, json: async () => ({ result }) };
    };
    const stats = await import(${JSON.stringify(path.join(ROOT, 'stats.js'))});
    stats.installStatsFlush();
    for (let i = 0; i < 5; i++) stats.record('GET', '/pay.html', 200);
    fs.writeFileSync(process.env.READY_FILE, 'ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      UPSTASH_REDIS_REST_URL: 'https://example.test/redis',
      UPSTASH_REDIS_REST_TOKEN: 'unit-test-token',
      READY_FILE: ready,
      LOG_FILE: log
    }
  });
  let err = '';
  child.stderr.on('data', d => { err += d; });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready)) {
    if (child.exitCode != null) throw new Error('child exited early ' + child.exitCode + ' ' + err.slice(0, 500));
    if (Date.now() > deadline) throw new Error('child did not become ready ' + err.slice(0, 500));
    await new Promise(r => setTimeout(r, 40));
  }
  child.kill('SIGTERM');
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0, err.slice(0, 500));
  const text = fs.readFileSync(log, 'utf8');
  assert.equal(text.split('\n').filter(l => l.startsWith('APPEND gw8:stats:buf:')).length, 1);
  assert.equal(text.split('\n').filter(l => l.startsWith('APPEND gw8:traffic:v1:buf:')).length, 1);
  assert.equal(text.includes('HINCRBY'), false);
});
