// Route x status traffic report: templates, surfaces, sanitized unmatched probes, and a free endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hasRedis } from '../alerts.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stats = await import('../stats.js');

function probePaths(report) {
  return report.sinceBoot.unmatchedProbes.map(p => p.path);
}
function routeRow(report, route) {
  return report.sinceBoot.routes.find(r => r.route === route);
}

test('traffic routes collapse ids and query strings, and classify surfaces', () => {
  assert.equal(stats.normalizeTrafficRoute('get', '/api/coin/BTC?foo=1'), 'GET /api/coin/:symbol');
  assert.equal(stats.surfaceOf('/api/coin/:symbol'), 'x402');
  assert.equal(stats.normalizeTrafficRoute('GET', '/api/verdict/base/0xabc'), 'GET /api/verdict/:chain/:address');
  assert.equal(stats.normalizeTrafficRoute('GET', '/mkt/rapidapi/coin/BTC?x=1'), 'GET /mkt/rapidapi/coin/:symbol');
  assert.equal(stats.surfaceOf('/mkt/rapidapi/coin/:symbol'), 'rapidapi');
  assert.equal(stats.normalizeTrafficRoute('GET', '/mkt/rapidapi/no-such'), 'GET /mkt/rapidapi/*');
  assert.equal(stats.normalizeTrafficRoute('GET', '/mkt/rapidapi'), 'GET /mkt/rapidapi');
  assert.equal(stats.surfaceOf('/mkt/rapidapi'), 'rapidapi');
  assert.equal(stats.normalizeTrafficRoute('GET', '/mkt/apify/growth/solana'), 'GET /mkt/apify/growth/:chain');
  assert.equal(stats.surfaceOf('/mkt/apify/growth/:chain'), 'public');
  assert.equal(stats.normalizeTrafficRoute('GET', '/pay.html'), 'GET /pay.html');
  assert.equal(stats.surfaceOf('/pay.html'), 'public');
  assert.equal(stats.normalizeTrafficRoute('GET', '/api/sample'), 'GET /api/sample');
  assert.equal(stats.surfaceOf('/api/sample'), 'public');
  assert.equal(stats.normalizeTrafficRoute('TRACE', '/.env'), 'OTHER other');
  assert.equal(stats.surfaceOf('other'), 'unmatched');
  assert.equal(stats.normalizeTrafficRoute('GET', '/api/traffic?days=7'), null);
  assert.equal(stats.normalizeTrafficRoute('GET', '/traffic.html'), null);
  assert.equal(stats.normalizeTrafficRoute('GET', '/api/stats'), null);
});

test('unmatched probe paths are truncated and stripped of secrets, queries, and IPs', () => {
  assert.equal(stats.sanitizeProbe('/.env'), '/.env');
  assert.equal(stats.sanitizeProbe('//wp-admin/'), '/wp-admin');
  assert.equal(stats.sanitizeProbe('/wp-login.php?token=querysecretvalue999'), '/wp-login.php');
  assert.equal(stats.sanitizeProbe('/scan/203.0.113.50'), '/scan/:ip');
  assert.equal(stats.sanitizeProbe('/user/a@b.com'), '/user/:email');
  const redacted = stats.sanitizeProbe('/x/sk-live-abcdefghijklmnopqrstuvwxyz');
  assert.equal(redacted.includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.match(redacted, /:redacted/);
  const long = '/' + Array.from({ length: 40 }, () => 'ab').join('/');
  const cut = stats.sanitizeProbe(long);
  assert.equal(cut.length, stats.TRAFFIC_LIMITS.probeLength);
  assert.match(cut, /^\/ab\/ab/);
  assert.equal(stats.sanitizeProbe('/wp-content/plugins/hello.php'), '/wp-content/plugins/hello.php');
  assert.equal(stats.sanitizeProbe('/' + 'a'.repeat(200)).includes('a'.repeat(20)), false);
  assert.equal(stats.sanitizeProbe('/%2eenv'), '/.env');
});

test('counts are route x status x UTC day, probes stay capped, and the report does not count itself', async () => {
  stats._resetTrafficForTests();
  assert.equal(stats.record('GET', '/api/traffic', 200), null);
  assert.equal(stats.record('GET', '/traffic.html', 200), null);

  stats.record('GET', '/api/coin/BTC?q=1', 402);
  stats.record('GET', '/api/coin/NOTACOIN', 404);
  stats.record('GET', '/pay.html', 200);
  stats.record('GET', '/mkt/rapidapi/coin/ETH', 200);
  stats.record('GET', '/.env', 404);
  stats.record('GET', '/wp-admin', 404);
  stats.record('GET', '/wp-admin', 404);
  stats.record('GET', '/secret-scan?token=querysecretvalue999', 404);
  stats.record('GET', '/scan/203.0.113.50', 404);

  const report = await stats.getTrafficReport(1);
  assert.equal(report.timezone, 'UTC');
  assert.equal(report.dates[0], stats.utcDate());
  assert.equal(report.days, 1);
  assert.equal(report.access.mode, 'public');
  assert.equal(report.access.env, 'TRAFFIC_REPORT_TOKEN');
  assert.match(report.reset.sinceBoot, /restart/i);
  assert.equal(hasRedis(), false);
  assert.match(report.reset.daily, /in-memory/i);

  const coin = routeRow(report, 'GET /api/coin/:symbol');
  assert.equal(coin.byStatus['402'], 1);
  assert.equal(coin.byStatus['404'], 1);
  assert.equal(routeRow(report, 'GET /pay.html').byStatus['200'], 1);
  assert.equal(routeRow(report, 'GET /mkt/rapidapi/coin/:symbol').byStatus['200'], 1);
  assert.equal(report.sinceBoot.surfaces.x402.byStatus['402'], 1);
  assert.equal(report.sinceBoot.surfaces.x402.byStatus['404'], 1);
  assert.equal(report.sinceBoot.surfaces.rapidapi.byStatus['200'], 1);
  assert.equal(report.sinceBoot.surfaces.public.byStatus['200'], 1);
  assert.equal(report.sinceBoot.topRoutes['402'][0].route, 'GET /api/coin/:symbol');
  assert.ok(report.sinceBoot.topRoutes['200'].some(r => r.route === 'GET /pay.html'));
  assert.ok(report.sinceBoot.topRoutes['404'].some(r => r.route === 'GET /api/coin/:symbol'));

  const probes = probePaths(report);
  assert.ok(probes.includes('/.env'));
  assert.ok(probes.includes('/wp-admin'));
  assert.equal(report.sinceBoot.unmatchedProbes.find(p => p.path === '/wp-admin').count, 2);
  assert.ok(probes.includes('/secret-scan'));
  assert.ok(probes.includes('/scan/:ip'));
  assert.equal(probes.includes('/api/coin/NOTACOIN'), false);
  assert.equal(probes.includes('/mkt/rapidapi/coin/ETH'), false);

  const blob = JSON.stringify(report);
  assert.equal(blob.includes('querysecretvalue999'), false);
  assert.equal(blob.includes('203.0.113.50'), false);
  assert.ok(report.sinceBoot.routes.every(r => !/\/api\/traffic|\/traffic\.html/.test(r.route)));
  assert.match(report.note, /not counted/);

  const day = report.daily.find(d => d.date === stats.utcDate());
  assert.equal(day.requests, report.sinceBoot.requests);
  assert.equal(day.byStatus['404'] >= 4, true);

  const html = stats.renderTrafficHtml(report);
  assert.match(html, /\/\.env/);
  assert.match(html, /wp-admin/);
  assert.match(html, /RapidAPI/);
  assert.match(html, /Since boot/);
  assert.equal(html.includes('querysecretvalue999'), false);

  const legacy = await stats.getStats(1);
  assert.ok(legacy.routes.every(r => !r.route.startsWith('r|') && !r.route.startsWith('s|')));
  assert.ok(legacy.routes.some(r => r.route === 'GET /api/coin/:symbol' && r.quotes >= 1));
});

test('probe list stays bounded and extra unmatched requests still count', async () => {
  stats._resetTrafficForTests();
  const n = stats.TRAFFIC_LIMITS.maxProbes + 5;
  for (let i = 0; i < n; i++) stats.record('GET', '/probe-' + i, 404);
  const report = await stats.getTrafficReport(7);
  assert.equal(report.sinceBoot.probesTracked, stats.TRAFFIC_LIMITS.maxProbes);
  assert.equal(report.sinceBoot.unmatchedProbes.length, stats.TRAFFIC_LIMITS.top);
  assert.equal(report.sinceBoot.probeOverflow, 5);
  assert.equal(report.sinceBoot.surfaces.unmatched.requests, n);
  assert.equal(report.sinceBoot.routes.filter(r => r.route === 'GET other').length, 1);
  assert.equal((await stats.getTrafficReport(99)).days, 30);
  assert.equal((await stats.getTrafficReport(0)).days, 1);
  assert.equal((await stats.getTrafficReport('nope')).days, 7);
});

test('middleware skips the report, ignores headers and bodies, and the token gate rejects query tokens', async (t) => {
  stats._resetTrafficForTests();
  const app = express();
  app.use(express.json());
  app.use(stats.statsMiddleware);
  stats.mountTrafficReport(app);
  app.get('/api/coin/:symbol', (req, res) => res.status(402).json({ error: 'payment required' }));
  app.get('/pay.html', (req, res) => res.status(200).type('html').send('ok'));
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const paid = await fetch(base + '/api/coin/BTC', {
    headers: { 'x-payment': 'payloaddoesnotbelong12345', 'x-forwarded-for': '203.0.113.77', 'user-agent': 'scanner/1.0' }
  });
  assert.equal(paid.status, 402);
  await fetch(base + '/.env', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret: 'bodysecretvalue12345' }) });
  await fetch(base + '/pay.html');

  const mid = await stats.getTrafficReport(1);
  assert.equal(mid.sinceBoot.byStatus['402'], 1);
  assert.equal(mid.sinceBoot.byStatus['200'], 1);
  assert.ok(probePaths(mid).includes('/.env'));
  const seen = JSON.stringify(mid);
  assert.equal(seen.includes('payloaddoesnotbelong12345'), false);
  assert.equal(seen.includes('bodysecretvalue12345'), false);
  assert.equal(seen.includes('203.0.113.77'), false);

  const view = await fetch(base + '/api/traffic');
  assert.equal(view.status, 200);
  assert.match(view.headers.get('cache-control') || '', /no-store/);
  const html = await fetch(base + '/traffic.html');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /\/\.env/);
  const after = await stats.getTrafficReport(1);
  assert.equal(after.sinceBoot.requests, mid.sinceBoot.requests);

  process.env.TRAFFIC_REPORT_TOKEN = 'unit-test-token';
  try {
    assert.equal((await fetch(base + '/api/traffic')).status, 401);
    assert.equal((await fetch(base + '/api/traffic?token=unit-test-token')).status, 401);
    assert.equal((await fetch(base + '/traffic.html')).status, 401);
    assert.equal((await fetch(base + '/api/traffic', { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
    const ok = await fetch(base + '/api/traffic', { headers: { authorization: 'Bearer unit-test-token' } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.access.mode, 'token');
    assert.equal(JSON.stringify(body).includes('unit-test-token'), false);
    const page = await fetch(base + '/traffic.html', { headers: { authorization: 'Bearer unit-test-token' } });
    assert.equal(page.status, 200);
    assert.equal((await page.text()).includes('unit-test-token'), false);
  } finally {
    delete process.env.TRAFFIC_REPORT_TOKEN;
  }
  assert.equal((await stats.getTrafficReport(1)).sinceBoot.requests, mid.sinceBoot.requests);
});

test('live server report is outside the x402 paywall and does not count itself', async (t) => {
  const port = 47000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port) },
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
  assert.equal((await fetch(base + '/api/coin/BTC')).status, 402);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/wp-admin')).status, 404);
  const rapid = await fetch(base + '/mkt/rapidapi/coin/BTC');
  assert.equal(rapid.status, 503);
  assert.equal((await fetch(base + '/pay.html')).status, 200);

  const first = await fetch(base + '/api/traffic?days=7');
  assert.equal(first.status, 200);
  assert.notEqual(first.status, 402);
  const report = await first.json();
  assert.equal(report.sinceBoot.topRoutes['402'][0].route, 'GET /api/coin/:symbol');
  assert.ok(report.sinceBoot.topRoutes['200'].some(r => r.route === 'GET /pay.html'));
  assert.ok(report.sinceBoot.unmatchedProbes.some(p => p.path === '/.env'));
  assert.ok(report.sinceBoot.unmatchedProbes.some(p => p.path === '/wp-admin'));
  assert.equal(report.sinceBoot.surfaces.rapidapi.requests, 1);
  assert.equal(report.sinceBoot.surfaces.x402.byStatus['402'], 1);
  const requests = report.sinceBoot.requests;

  const second = await fetch(base + '/api/traffic');
  assert.equal((await second.json()).sinceBoot.requests, requests);
  const page = await fetch(base + '/traffic.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /html/);
  const html = await page.text();
  assert.match(html, /\/\.env/);
  assert.match(html, /Reset/);
  const third = await (await fetch(base + '/api/traffic')).json();
  assert.equal(third.sinceBoot.requests, requests);
  assert.ok(third.sinceBoot.routes.every(r => !/\/api\/traffic|\/traffic\.html/.test(r.route)));
  assert.ok(third.sinceBoot.unmatchedProbes.every(p => p.path !== '/api/traffic' && p.path !== '/traffic.html'));

  const doc = await (await fetch(base + '/openapi.json')).json();
  assert.deepEqual(doc.paths['/api/traffic'].get.security, []);
  assert.equal(doc.paths['/api/traffic'].get['x-payment-info'], undefined);
  const home = await (await fetch(base + '/')).json();
  assert.equal(home.free.traffic, '/api/traffic');
  assert.equal(home.free.trafficHtml, '/traffic.html');
  const llms = await (await fetch(base + '/llms.txt')).text();
  assert.match(llms, /\/api\/traffic/);
});
