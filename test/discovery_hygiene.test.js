// Discovery copy is 1.2.1, static mcp.json matches the route, multi-rail is named only on the five HTTP routes, and the free aliases answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PASS_PLAN } from '../pass.js';
import { normalizeRoute, normalizeTrafficRoute } from '../stats.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FORBIDDEN = 'HtffQ9mFdLcyCoNnh5nbDnTyaFLEcLQh' + 'S8NnWZp3axFg';
const BASE_PAYTO = '0xB4527dccaC81eB73d4988A51a4cb1FBBF2C3CaBd';
const SOL_PAYTO = '3ZgRNAMaM39WQt7rvwMf7tZjQakZqA5ieULpoQuo4chD';
const RAILS = ['GET /api/rails', 'GET /api/rails/route', 'GET /api/regime', 'POST /api/pay/should-i-pay', 'GET /api/coin/{symbol}'];
const SINGLE = ['/api/dots', '/api/brief', '/api/verdict/{chain}/{address}', '/api/pass/day', '/api/spend/check'];
const SITEMAP = ['/', '/llms.txt', '/agents.md', '/openapi.json', '/.well-known/x402', '/.well-known/agent.json', '/pay', '/pay.html', '/track', '/health'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function boot(t) {
  const port = 51200 + Math.floor(Math.random() * 800);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), BRIEF_PREWARM: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let err = '';
  srv.stderr.on('data', d => { err += d; });
  t.after(() => srv.kill());
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('server did not start ' + err.slice(0, 400))), 20000);
    srv.stdout.on('data', d => { if (/online on port/.test(String(d))) { clearTimeout(to); res(`http://127.0.0.1:${port}`); } });
  });
}

test('versions, static mcp.json, multi-rail HTTP copy, day pass docs, and free aliases', async (t) => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.0.0');
  const serverSrc = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(serverSrc, /const API_VERSION = '1\.2\.1'/);
  assert.equal(serverSrc.includes('1.2.0'), false);
  assert.match(serverSrc, /new McpServer\(\{ name: 'gw8-crypto-signal', version: API_VERSION \}\)/);
  assert.equal(serverSrc.includes(FORBIDDEN), false);
  assert.ok(serverSrc.includes(BASE_PAYTO));
  assert.match(serverSrc, /const SOLANA_VAULT_ADDRESS = SOLANA_PAYTO/);
  const solanaSrc = readFileSync(path.join(ROOT, 'solana_pay.js'), 'utf8');
  assert.ok(solanaSrc.includes(`export const SOLANA_PAYTO = '${SOL_PAYTO}'`));
  assert.equal(solanaSrc.includes(FORBIDDEN), false);

  const fileCard = JSON.parse(readFileSync(path.join(ROOT, 'mcp.json'), 'utf8'));
  assert.equal(fileCard.version, '1.2.1');
  assert.equal(fileCard.payment.network, 'eip155:8453');
  assert.equal(fileCard.payment.mcpInBand, false);
  assert.equal(fileCard.payment.version, 2);
  assert.equal(fileCard.dayPass.priceUsd, PASS_PLAN.priceUsd);
  assert.equal(fileCard.dayPass.hours, PASS_PLAN.hours);
  assert.equal(fileCard.dayPass.dailyCap, PASS_PLAN.dailyCap);
  assert.equal(fileCard.dayPass.perMinute, PASS_PLAN.perMinute);
  assert.equal(fileCard.dayPass.header, 'X-GW8-Pass');
  assert.equal(/polygon|solana|eip155:137/i.test(JSON.stringify(fileCard)), false);

  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const llmsFile = readFileSync(path.join(ROOT, 'llms.txt'), 'utf8');
  for (const text of [readme, llmsFile]) {
    for (const route of RAILS) assert.ok(text.includes(route), route);
    assert.ok(text.includes(BASE_PAYTO));
    assert.ok(text.includes(SOL_PAYTO));
    assert.equal(text.includes(FORBIDDEN), false);
  }
  assert.match(readme, /POST \/api\/pass\/day/);
  assert.match(readme, /\$1\.00/);
  assert.match(readme, /24 hours/);
  assert.match(readme, /X-GW8-Pass/);
  assert.match(readme, /2000 calls per pass/);
  assert.match(readme, /60 calls per minute/);
  assert.match(readme, /\/api\/alerts\/subscribe/);
  assert.match(readme, /\/api\/brief\/weekly\/subscribe/);
  assert.match(readme, /MCP tools \(`POST \/mcp`\) stay USDC on Base/);
  assert.match(llmsFile, /MCP \(`POST \/mcp`, `GET \/mcp\.json`\) stays USDC on Base only/);

  for (const file of walk(ROOT)) {
    if (statSync(file).size > 2_000_000) continue;
    const text = readFileSync(file);
    assert.equal(text.includes(Buffer.from(FORBIDDEN)), false, file);
  }

  assert.equal(normalizeRoute('GET', '/health'), null);
  assert.equal(normalizeTrafficRoute('GET', '/health'), null);
  assert.equal(normalizeRoute('GET', '/pay'), 'GET /pay');
  assert.equal(normalizeRoute('GET', '/robots.txt'), 'GET /robots.txt');
  assert.equal(normalizeRoute('GET', '/sitemap.xml'), 'GET /sitemap.xml');

  const base = await boot(t);
  const doc = await (await fetch(base + '/openapi.json')).json();
  assert.equal(doc.info.version, '1.2.1');
  assert.match(doc.info.description, /Multi-rail on HTTP only/);
  assert.match(doc.info['x-guidance'], /^Day pass first/);
  for (const route of RAILS) {
    assert.ok(doc.info.description.includes(route), route);
    assert.ok(doc.info['x-guidance'].includes(route), route);
  }
  assert.match(doc.info.description, /MCP tools stay USDC on Base/);
  assert.ok(doc.info.description.includes(BASE_PAYTO));
  assert.ok(doc.info.description.includes(SOL_PAYTO));
  assert.equal(doc.paths['/api/brief'].get['x-payment-info'].price.amount, '0.02');
  assert.equal(doc.paths['/api/pass/day'].post['x-payment-info'].price.amount, '1.00');
  assert.equal(doc.paths['/api/rails'].get['x-payment-info'].price.amount, '0.002');
  assert.equal(doc.paths['/api/regime'].get['x-payment-info'].price.amount, '0.01');
  assert.equal(doc.paths['/api/coin/{symbol}'].get['x-payment-info'].price.amount, '0.002');
  for (const route of RAILS) {
    const [method, p] = [route.slice(0, route.indexOf(' ')).toLowerCase(), route.slice(route.indexOf(' ') + 1)];
    const desc = doc.paths[p][method].responses['402'].description;
    assert.match(desc, /Polygon USDC \(eip155:137\) and Solana USDC at the same price/);
    assert.match(desc, /Day pass first/);
    assert.equal(desc.includes(FORBIDDEN), false);
  }
  for (const p of SINGLE) {
    const op = doc.paths[p].get || doc.paths[p].post;
    assert.doesNotMatch(op.responses['402'].description, /Polygon|Solana/);
  }
  assert.equal(doc.paths['/health'].get['x-payment-info'], undefined);
  assert.equal(doc.paths['/pay'].get['x-payment-info'], undefined);

  const card = await (await fetch(base + '/.well-known/agent.json')).json();
  assert.equal(card.version, '1.2.1');
  for (const route of RAILS) assert.ok(card.description.includes(route), route);
  assert.match(card.description, /MCP tools stay USDC on Base and do not accept Polygon or Solana/);
  const dots = card.skills.find(s => String(s.examples[0]).includes('/api/dots'));
  assert.ok(dots);
  assert.doesNotMatch(dots.description, /Polygon|Solana/);

  const home = await (await fetch(base + '/')).json();
  assert.equal(home.version, '1.2.1');
  assert.equal(home.multiRail.httpOnly, true);
  assert.deepEqual(home.multiRail.routes, RAILS);
  assert.match(home.about, /Multi-rail on HTTP only/);
  assert.equal(home.convenience.health, '/health');
  assert.equal(home.convenience.pay, '/pay');
  assert.equal(home.humans.pay, '/pay.html');
  assert.equal(home.lead.priceUsd, '0.02');
  assert.equal(home.bestValue.priceUsd, '1.00');

  const llms = await (await fetch(base + '/llms.txt')).text();
  for (const route of RAILS) assert.ok(llms.includes(route), route);
  assert.match(llms, /stays USDC on Base only/);
  assert.ok(llms.includes(BASE_PAYTO));
  assert.ok(llms.includes(SOL_PAYTO));

  const live = await (await fetch(base + '/mcp.json')).json();
  const alias = await (await fetch(base + '/.well-known/mcp.json')).json();
  const serverCard = await (await fetch(base + '/.well-known/mcp/server-card.json')).json();
  assert.deepEqual(alias, live);
  assert.deepEqual(serverCard, live);
  assert.deepEqual(live, fileCard);
  assert.equal(live.version, '1.2.1');
  assert.equal(live.payment.network, 'eip155:8453');
  assert.equal(live.payment.mcpInBand, false);
  assert.equal(/polygon|solana|eip155:137/i.test(JSON.stringify(live)), false);

  const init = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hygiene', version: '0' } } })
  });
  const initText = await init.text();
  assert.equal(init.status, 200, initText.slice(0, 400));
  assert.match(initText, /"version":"1\.2\.1"/);
  assert.doesNotMatch(initText, /polygon|solana|eip155:137/i);

  const ready = await fetch(base + '/api/ready');
  const health = await fetch(base + '/health');
  assert.equal(health.status, ready.status);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), await ready.json());
  assert.equal(health.headers.get('retry-after'), ready.headers.get('retry-after'));

  const pay = await fetch(base + '/pay', { redirect: 'manual' });
  assert.equal(pay.status, 302);
  assert.equal(pay.headers.get('location'), '/pay.html');
  const page = await fetch(base + '/pay.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /html/);
  assert.match(await page.text(), /Base USDC/);

  const robots = await fetch(base + '/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type') || '', /text\/plain/);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /^User-agent: \*/);
  assert.match(robotsBody, /Allow: \//);
  assert.match(robotsBody, /Sitemap: https:\/\/micro-saas-agent\.onrender\.com\/sitemap\.xml/);

  const map = await fetch(base + '/sitemap.xml');
  assert.equal(map.status, 200);
  assert.match(map.headers.get('content-type') || '', /xml/);
  const xml = await map.text();
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  for (const p of SITEMAP) assert.ok(xml.includes('https://micro-saas-agent.onrender.com' + p), p);
  assert.equal(xml.includes('/api/brief'), false);

  const quote = await fetch(base + '/api/pay/should-i-pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(quote.status, 402);
  const dotsQuote = await fetch(base + '/api/dots');
  assert.equal(dotsQuote.status, 402);
});
