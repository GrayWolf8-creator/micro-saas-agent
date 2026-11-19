// Readiness gate and the cold teaser/paid path. Network is stubbed or not used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BRIEF_READY_CAP_MS, TEASER_COLD_WAIT_MS, briefReadyStatus, briefPrewarmEnabled, createBriefCache } from '../upgrades.js';
import { normalizeRoute, normalizeTrafficRoute } from '../stats.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const flush = () => new Promise(r => setImmediate(r));

test('ready is 503 until the first prewarm attempt settles, 200 when prewarm is off, and 200 at the 120s cap', () => {
  assert.equal(BRIEF_READY_CAP_MS, 120_000);
  assert.equal(TEASER_COLD_WAIT_MS, 3_000);
  const boot = 1_000_000;
  const cold = briefReadyStatus({ now: boot + 1000, boot, capMs: BRIEF_READY_CAP_MS, enabled: true, settled: false });
  assert.equal(cold.http, 503);
  assert.equal(cold.ready, false);
  assert.equal(cold.retryAfter, 5);
  const done = briefReadyStatus({ now: boot + 1000, boot, capMs: BRIEF_READY_CAP_MS, enabled: true, settled: true, ok: true });
  assert.equal(done.http, 200);
  assert.equal(done.ready, true);
  assert.equal(done.reason, 'ready');
  const failed = briefReadyStatus({ now: boot + 1000, boot, capMs: BRIEF_READY_CAP_MS, enabled: true, settled: true, ok: false });
  assert.equal(failed.http, 200);
  assert.equal(failed.reason, 'prewarm failed');
  const capped = briefReadyStatus({ now: boot + BRIEF_READY_CAP_MS, boot, capMs: BRIEF_READY_CAP_MS, enabled: true, settled: false });
  assert.equal(capped.http, 200);
  assert.equal(capped.reason, 'boot cap');
  assert.equal(briefPrewarmEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(briefPrewarmEnabled({ BRIEF_PREWARM: 'off' }), false);
  const off = briefReadyStatus({ now: boot, boot, enabled: false, settled: false });
  assert.equal(off.http, 200);
  assert.equal(off.reason, 'prewarm off');
});

test('a cold brief with no previous copy returns in the 3s budget instead of waiting out the build', async () => {
  let waited = null;
  let release;
  const gate = new Promise(r => { release = r; });
  const get = createBriefCache({
    log: () => {},
    sleep: async (ms) => { waited = ms; },
    build: async (bar) => { await gate; return { bar: bar.bar, barClose: bar.barClose, regime: { score: 1 } }; }
  });
  const started = Date.now();
  const cold = await get({ maxWaitMs: TEASER_COLD_WAIT_MS });
  assert.equal(Date.now() - started < 1000, true);
  assert.equal(waited, TEASER_COLD_WAIT_MS);
  assert.equal(cold.notReady, true);
  assert.equal(cold.http, 503);
  assert.equal(cold.retryAfter, 5);
  assert.match(cold.error, /warming up/);
  release();
  await flush();
  const ready = await get();
  assert.equal(ready.notReady, undefined);
  assert.equal(ready.regime.score, 1);
});

test('/api/ready is not counted, and a cold paid brief is not settled', async (t) => {
  assert.equal(normalizeRoute('GET', '/api/ready'), null);
  assert.equal(normalizeTrafficRoute('GET', '/api/ready'), null);
  const port = 47000 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, ['--import', path.join(ROOT, 'test', 'helpers', 'brief_not_ready.mjs'), 'server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), GW8_TEST_HOOKS: '1', BRIEF_PREWARM: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  srv.stderr.on('data', d => { err += d; });
  t.after(() => srv.kill());
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start ' + err.slice(0, 400))), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = await fetch(base + '/api/ready');
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.equal(readyBody.ready, true);
  assert.equal(readyBody.reason, 'prewarm off');

  const t0 = Date.now();
  const teaser = await fetch(base + '/api/brief/teaser');
  const teaserBody = await teaser.json();
  assert.equal(teaser.status, 503);
  assert.equal(teaser.headers.get('retry-after'), '5');
  assert.equal(teaserBody.retryAfter, 5);
  assert.match(teaserBody.error, /warming up/);
  assert.equal(Date.now() - t0 < 1000, true);

  const quote = await fetch(base + '/api/brief');
  assert.equal(quote.status, 402);

  const paidAt = Date.now();
  const paid = await fetch(base + '/api/brief', { headers: { 'PAYMENT-SIGNATURE': 'dGVzdA==' } });
  const paidBody = await paid.json();
  assert.equal(paid.status, 503);
  assert.equal(paid.headers.get('retry-after'), '5');
  assert.equal(paidBody.note, 'no payment was taken');
  assert.equal(paid.headers.get('payment-response'), null);
  assert.equal(Date.now() - paidAt < 1000, true);
  assert.match(paidBody.error, /warming up/);
});
