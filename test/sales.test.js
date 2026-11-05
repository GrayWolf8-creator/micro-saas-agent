// Sales ledger: route x surface x UTC day. No IPs, wallets, headers, or bodies.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sales from '../sales.js';
import * as stats from '../stats.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WALLET = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
const ADDR = '0x1111111111111111111111111111111111111111';

function freshFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw8-sales-'));
  const file = path.join(dir, 'sales-counts.json');
  sales._resetSalesForTests({ file });
  return { dir, file };
}

async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines;
}

function saleLines(lines) {
  return lines.filter(l => l.startsWith('[gw8-sale] ')).map(l => JSON.parse(l.slice('[gw8-sale] '.length)));
}

function row(report, route, surface) {
  return report.routes.find(r => r.route === route && r.surface === surface);
}

describe('sales ledger', { concurrency: false }, () => {
test('paid, pass, sample, free, and 402 counts stay on the route template', async () => {
  const { dir, file } = freshFile();
  const lines = await capture(async () => {
    assert.equal(sales.classifySale({ method: 'GET', path: '/api/coin/BTC?payer=' + WALLET + '&ip=203.0.113.9', statusCode: 402 }).event, 'quotes');
    sales.recordFromResponse({ method: 'GET', path: '/api/coin/BTC?payer=' + WALLET + '&ip=203.0.113.9', statusCode: 402 });
    sales.recordFromResponse({ method: 'GET', path: '/api/coin/ETH', statusCode: 402 });
    sales.recordFromResponse({ method: 'POST', path: '/api/pass/day', statusCode: 200, access: 'x402' });
    sales.recordFromResponse({ method: 'POST', path: '/api/pass/day', statusCode: 200, access: 'x402', replay: true });
    sales.recordFromResponse({ method: 'GET', path: '/api/coin/ETH', statusCode: 200, access: 'daypass' });
    sales.recordFromResponse({ method: 'GET', path: '/api/coin/ETH?sample=1', statusCode: 200, sample: true });
    sales.recordFromResponse({ method: 'GET', path: '/api/sample', statusCode: 200 });
    sales.recordFromResponse({ method: 'GET', path: '/pay.html', statusCode: 200 });
    sales.recordFromResponse({ method: 'GET', path: '/', statusCode: 200 });
    sales.recordFromResponse({ method: 'GET', path: '/api/sales', statusCode: 200 });
    sales.recordFromResponse({ method: 'POST', path: '/mcp', statusCode: 200 });
    sales.recordMcpSale('get_coin', WALLET);
    sales.recordFromResponse({
      method: 'GET',
      path: '/mkt/rapidapi/verdict/base/' + ADDR,
      statusCode: 200,
      channel: 'MARKETPLACE_RAPIDAPI'
    });
    sales.recordFromResponse({ method: 'GET', path: '/mkt/apify/regime', statusCode: 200, channel: 'MARKETPLACE_APIFY' });
    sales.recordFromResponse({ method: 'GET', path: '/mkt/rapidapi/coin/BTC', statusCode: 503, channel: 'MARKETPLACE_RAPIDAPI' });
  });
  const logged = saleLines(lines);
  assert.equal(logged.length, 4);
  for (const line of logged) assert.deepEqual(Object.keys(line).sort(), ['day', 'event', 'route', 'surface', 'v']);
  assert.equal(logged.every(l => l.event === 'paid' && l.v === 1 && l.day === stats.utcDate()), true);
  assert.equal(JSON.stringify(logged).includes(WALLET), false);
  assert.equal(JSON.stringify(logged).includes(ADDR), false);
  assert.equal(JSON.stringify(logged).includes('203.0.113.9'), false);
  assert.ok(logged.some(l => l.route === 'POST /api/pass/day' && l.surface === 'x402'));
  assert.ok(logged.some(l => l.route === 'MCP get_coin' && l.surface === 'x402'));
  assert.ok(logged.some(l => l.route === 'GET /mkt/rapidapi/verdict/:chain/:address' && l.surface === 'rapidapi'));
  assert.ok(logged.some(l => l.route === 'GET /mkt/apify/regime' && l.surface === 'apify'));

  const report = sales.getSales(1);
  assert.equal(report.timezone, 'UTC');
  assert.equal(report.dates[0], stats.utcDate());
  assert.equal(report.days, 1);
  const coin = row(report, 'GET /api/coin/:symbol', 'x402');
  assert.equal(coin.quotes, 2);
  assert.equal(coin.pass, 1);
  assert.equal(coin.sample, 1);
  assert.equal(coin.paid, 0);
  assert.equal(row(report, 'POST /api/pass/day', 'x402').paid, 1);
  assert.equal(row(report, 'GET /api/sample', 'public').sample, 1);
  assert.equal(row(report, 'GET /pay.html', 'public').free, 1);
  assert.equal(row(report, 'MCP get_coin', 'x402').paid, 1);
  assert.equal(row(report, 'GET /mkt/rapidapi/verdict/:chain/:address', 'rapidapi').paid, 1);
  assert.equal(row(report, 'GET /mkt/apify/regime', 'apify').paid, 1);
  assert.equal(report.bySurface.x402.paid, 2);
  assert.equal(report.bySurface.x402.quotes, 2);
  assert.equal(report.bySurface.x402.pass, 1);
  assert.equal(report.bySurface.rapidapi.paid, 1);
  assert.equal(report.bySurface.apify.paid, 1);
  assert.equal(report.totals.free, 1);
  assert.equal(report.routes.some(r => r.route === 'GET /' || r.route === 'GET /api/sales' || r.route === 'POST /mcp'), false);
  const blob = JSON.stringify(report);
  assert.equal(blob.includes(WALLET), false);
  assert.equal(blob.includes(ADDR), false);
  assert.equal(blob.includes('203.0.113.9'), false);
  assert.equal(blob.includes(dir), false);
  assert.equal(blob.includes('payer'), false);

  sales.flushSalesNow();
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.v, 1);
  assert.equal(JSON.stringify(stored).includes(WALLET), false);
  assert.equal(JSON.stringify(stored).includes(ADDR), false);
  sales._resetSalesForTests({ file });
  const reloaded = sales.getSales(1);
  assert.equal(row(reloaded, 'GET /api/coin/:symbol', 'x402').quotes, 2);
  assert.equal(row(reloaded, 'POST /api/pass/day', 'x402').paid, 1);
  assert.equal(row(reloaded, 'GET /mkt/rapidapi/verdict/:chain/:address', 'rapidapi').paid, 1);
});

test('a poisoned counts file cannot reintroduce an address', () => {
  const { file } = freshFile();
  const day = stats.utcDate();
  const days = {};
  days[day] = {
    'GET /api/rails|x402': { paid: 2, pass: 0, sample: 0, free: 0, quotes: 4 },
    ['GET /api/coin/' + ADDR + '|x402']: { paid: 9, quotes: 9 },
    'GET /secret?token=abc|x402': { paid: 4 }
  };
  fs.writeFileSync(file, JSON.stringify({ v: 1, dropped: 0, days }));
  sales._resetSalesForTests({ file, load: true });
  const report = sales.getSales(1);
  assert.equal(row(report, 'GET /api/rails', 'x402').paid, 2);
  assert.equal(row(report, 'GET /api/rails', 'x402').quotes, 4);
  assert.equal(report.totals.paid, 2);
  assert.equal(JSON.stringify(report).includes(ADDR), false);
  assert.equal(JSON.stringify(report).includes('token=abc'), false);
});

test('route cap counts the overflow without storing a new route', () => {
  const { file } = freshFile();
  const day = stats.utcDate();
  const routes = {};
  for (let i = 0; i < sales.SALES_MAX_ROUTES; i++) {
    routes['MCP tool' + i + '|x402'] = { paid: 1, pass: 0, sample: 0, free: 0, quotes: 0 };
  }
  fs.writeFileSync(file, JSON.stringify({ v: 1, dropped: 0, days: { [day]: routes } }));
  sales._resetSalesForTests({ file, load: true });
  assert.equal(sales.recordMcpSale('overflowtool'), null);
  const report = sales.getSales(1);
  assert.equal(report.dropped, 1);
  assert.equal(report.routes.length, sales.SALES_MAX_ROUTES);
  assert.equal(report.routes.some(r => r.route === 'MCP overflowtool'), false);
});

test('middleware reads only status, route, and the access flag', async () => {
  freshFile();
  let finish = () => {};
  const req = {
    method: 'GET',
    path: '/api/brief',
    headers: { 'payment-signature': 'secret-signature', 'x-forwarded-for': '203.0.113.50' },
    body: { webhookUrl: 'https://example.com/hook', payer: WALLET }
  };
  const res = {
    statusCode: 200,
    locals: { gw8Access: 'x402', gw8Payer: WALLET },
    on(ev, fn) { if (ev === 'finish') finish = fn; }
  };
  const lines = await capture(async () => {
    sales.salesMiddleware(req, res, () => {});
    finish();
  });
  const logged = saleLines(lines);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].route, 'GET /api/brief');
  assert.equal(logged[0].surface, 'x402');
  const blob = JSON.stringify(sales.getSales(1)) + JSON.stringify(logged);
  assert.equal(blob.includes('secret-signature'), false);
  assert.equal(blob.includes(WALLET), false);
  assert.equal(blob.includes('203.0.113.50'), false);
  assert.equal(blob.includes('example.com'), false);
});

test('the sales route is not recorded by the traffic counter', () => {
  assert.equal(stats.normalizeRoute('GET', '/api/sales'), null);
  assert.equal(stats.normalizeTrafficRoute('GET', '/api/sales?days=30'), null);
});

test('SIGTERM writes quote counts that were still buffered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw8-sales-sig-'));
  const file = path.join(dir, 'sales-counts.json');
  const ready = path.join(dir, 'ready');
  const script = `
    import fs from 'fs';
    const sales = await import(${JSON.stringify(path.join(ROOT, 'sales.js'))});
    sales._resetSalesForTests({ file: process.env.SALES_FILE });
    sales.installSalesFlush();
    sales.recordFromResponse({ method: 'GET', path: '/api/rails', statusCode: 402 });
    fs.writeFileSync(process.env.READY, 'ready');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, SALES_FILE: file, READY: ready },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const started = Date.now() + 10000;
  while (!fs.existsSync(ready)) {
    if (child.exitCode != null) throw new Error('child exited early ' + child.exitCode + ' ' + err.slice(0, 500));
    if (Date.now() > started) throw new Error('child did not become ready ' + err.slice(0, 500));
    await new Promise(r => setTimeout(r, 40));
  }
  child.kill('SIGTERM');
  const deadline = Date.now() + 8000;
  let body = '';
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      body = fs.readFileSync(file, 'utf8');
      if (body.includes('"quotes":1') && out.includes('[gw8-sales-snapshot]')) break;
    }
    await new Promise(r => setTimeout(r, 40));
  }
  child.kill('SIGKILL');
  assert.match(body, /"quotes":1/, err.slice(0, 300));
  assert.equal(body.includes(WALLET), false);
  assert.match(out, /\[gw8-sales-snapshot\]/);
  assert.equal(out.includes('gw8-sales-sig-'), false);
  const snapLine = out.split('\n').find(l => l.startsWith('[gw8-sales-snapshot] '));
  const snap = JSON.parse(snapLine.slice('[gw8-sales-snapshot] '.length));
  assert.equal(snap.v, 1);
  assert.equal(snap.timezone, 'UTC');
  const day = snap.days[stats.utcDate()];
  assert.equal(day['GET /api/rails|x402'].quotes, 1);
  assert.equal(JSON.stringify(snap).includes('payer'), false);
});

test('GET /api/sales is free, public, and outside the x402 paywall', async (t) => {
  const port = 53000 + Math.floor(Math.random() * 1000);
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
  const firstRes = await fetch(base + '/api/sales?days=1');
  assert.equal(firstRes.status, 200);
  assert.notEqual(firstRes.status, 402);
  assert.match(firstRes.headers.get('cache-control') || '', /no-store/);
  const first = await firstRes.json();
  assert.equal(first.timezone, 'UTC');
  assert.equal(JSON.stringify(first).includes(WALLET), false);

  const coin = await fetch(base + '/api/coin/BTC');
  assert.equal(coin.status, 402);
  const challenge = JSON.parse(Buffer.from(coin.headers.get('payment-required'), 'base64').toString('utf8'));
  assert.equal(challenge.accepts[0].payTo, WALLET);
  assert.equal(challenge.accepts[0].amount, '2000');
  assert.ok(challenge.extensions && challenge.extensions.bazaar && challenge.extensions.bazaar.info);

  const rapid = await fetch(base + '/mkt/rapidapi/coin/BTC');
  assert.equal(rapid.status, 503);

  const second = await (await fetch(base + '/api/sales?days=1')).json();
  const third = await (await fetch(base + '/api/sales?days=1')).json();
  const coinRow = r => (r.routes.find(x => x.route === 'GET /api/coin/:symbol' && x.surface === 'x402') || { quotes: 0 }).quotes;
  assert.equal(coinRow(second), coinRow(first) + 1);
  assert.equal(coinRow(third), coinRow(second));
  assert.equal(second.bySurface.rapidapi.paid, first.bySurface.rapidapi.paid);
  assert.equal(JSON.stringify(third).includes(WALLET), false);
  assert.equal(third.routes.some(r => r.route === 'GET /api/sales'), false);

  const doc = await (await fetch(base + '/openapi.json')).json();
  assert.deepEqual(doc.paths['/api/sales'].get.security, []);
  assert.equal(doc.paths['/api/sales'].get['x-payment-info'], undefined);
  const disc = await (await fetch(base + '/.well-known/x402')).json();
  assert.equal(JSON.stringify(disc.resources).includes('/api/sales'), false);
  assert.match(disc.resources[0], /\/api\/pass\/day$/);
  const home = await (await fetch(base + '/')).json();
  assert.equal(home.free.sales, '/api/sales');
});
});
