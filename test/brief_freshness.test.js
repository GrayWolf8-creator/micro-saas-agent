// Paid brief cache is keyed to the latest closed Kraken 4h bar. ETF totals are parsed offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCategory, MAX_RESOURCE_DESCRIPTION } from '../catalog.js';
import { BRIEF_QUOTE, latestClosed4hBar, createBriefCache, assembleBrief, etfUnavailableNote } from '../upgrades.js';
import { cacheCoversBar, parseFarsideBtcHtml, parseCoinBossEtf, readEtfFlows } from '../Signal.js';

const ETF_RULE = '3-day net BTC ETF flow > 0 (Farside)';
const sleepImpl = async () => {};

function html(rows) {
  const body = rows.map(r => `<tr><td>${r[0]}</td><td>1.0</td><td>1.0</td><td>${r[1]}</td></tr>`).join('');
  return `<table><tr><th>Date</th><th>IBIT</th><th>FBTC</th><th>Total</th></tr>${body}</table>`;
}

const FARSIDE_FAIL = html([
  ['16 Nov 2026', '7.9'],
  ['17 Nov 2026', '(239.9)'],
  ['18 Nov 2026', '(157.8)']
]);

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test('402 quote says the brief refreshes on each closed 4h bar and stays within 500 characters', () => {
  const description = withCategory('/api/brief', BRIEF_QUOTE);
  assert.match(description, /^\[Daily crypto brief\] /);
  assert.match(description, /closed Kraken 4h bar/);
  assert.equal(description.length <= MAX_RESOURCE_DESCRIPTION, true, String(description.length));
  assert.doesNotMatch(description, /once per|once each|once-per-day|mountain time day/i);
});

test('latest closed 4h bar is the UTC bar that has already closed', () => {
  assert.deepEqual(latestClosed4hBar(Date.parse('2026-11-19T02:30:00.000Z')), {
    bar: '2026-11-18T20:00:00.000Z', barClose: '2026-11-19T00:00:00.000Z'
  });
  assert.deepEqual(latestClosed4hBar(Date.parse('2026-11-19T03:59:59.000Z')), {
    bar: '2026-11-18T20:00:00.000Z', barClose: '2026-11-19T00:00:00.000Z'
  });
  // 04:00 UTC is 9:00 PM Mountain Time in November. That close starts a new brief.
  assert.deepEqual(latestClosed4hBar(Date.parse('2026-11-19T04:00:00.000Z')), {
    bar: '2026-11-19T00:00:00.000Z', barClose: '2026-11-19T04:00:00.000Z'
  });
  // 08:00 UTC is 1:00 AM Mountain Time.
  assert.deepEqual(latestClosed4hBar(Date.parse('2026-11-19T08:00:00.000Z')), {
    bar: '2026-11-19T04:00:00.000Z', barClose: '2026-11-19T08:00:00.000Z'
  });
});

test('a scan covers a bar only when its newest candle open is at least that bar', () => {
  const data = { core: [{ name: 'BTC', barOpen: '2026-11-18T20:00:00.000Z' }], others: [{ barOpen: '2026-11-18T16:00:00.000Z' }] };
  assert.equal(cacheCoversBar(data, ''), true);
  assert.equal(cacheCoversBar(data, '2026-11-18T20:00:00.000Z'), true);
  assert.equal(cacheCoversBar(data, '2026-11-19T00:00:00.000Z'), false);
  assert.equal(cacheCoversBar({ core: [], others: [] }, '2026-11-19T00:00:00.000Z'), false);
});

test('brief cache is reused inside a 4h bar, rebuilt on the next close, and one build serves concurrent callers', async () => {
  let now = Date.parse('2026-11-19T00:30:00.000Z');
  let calls = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const get = createBriefCache({
    now: () => now,
    build: async (bar) => {
      calls++;
      if (calls === 1) await gate;
      return { bar: bar.bar, barClose: bar.barClose, regime: { score: calls } };
    }
  });
  const pending = [get(), get(), get()];
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 1);
  release();
  const first = await Promise.all(pending);
  assert.equal(first[0], first[1]);
  assert.equal(first[1], first[2]);
  assert.equal(first[0].bar, '2026-11-18T20:00:00.000Z');
  assert.equal(first[0].barClose, '2026-11-19T00:00:00.000Z');
  now = Date.parse('2026-11-19T03:59:59.000Z');
  const again = await get();
  assert.equal(calls, 1);
  assert.equal(again, first[0]);
  now = Date.parse('2026-11-19T04:00:00.000Z');
  const next = await get();
  assert.equal(calls, 2);
  assert.equal(next.bar, '2026-11-19T00:00:00.000Z');
  assert.equal(next.barClose, '2026-11-19T04:00:00.000Z');
  assert.notEqual(next, first[0]);
});

test('a failed brief build is not cached, and a lagging candle is reused only for the short lag window', async () => {
  let now = Date.parse('2026-11-19T02:30:00.000Z');
  let failures = 0;
  const failing = createBriefCache({
    now: () => now,
    build: async () => { failures++; return { error: 'upstream data unavailable, retry shortly' }; }
  });
  assert.equal((await failing()).error, 'upstream data unavailable, retry shortly');
  assert.equal((await failing()).error, 'upstream data unavailable, retry shortly');
  assert.equal(failures, 2);

  let lagCalls = 0;
  const lagging = createBriefCache({
    now: () => now,
    lagTtlMs: 1000,
    build: async () => {
      lagCalls++;
      return { bar: '2026-11-18T16:00:00.000Z', barClose: '2026-11-18T20:00:00.000Z', regime: { score: 1 } };
    }
  });
  const held = await lagging();
  assert.equal(await lagging(), held);
  assert.equal(lagCalls, 1);
  now += 1000;
  await lagging();
  assert.equal(lagCalls, 2);
});

test('the brief names the 4h bar and says in plain words when the ETF check is unknown', () => {
  const bar = { bar: '2026-11-18T20:00:00.000Z', barClose: '2026-11-19T00:00:00.000Z' };
  const dots = { asOf: '2026-11-19T00:02:00.000Z', bandDots: [{ name: 'LINK', kind: 'green' }, { name: 'AAVE', kind: 'red' }] };
  const unavailable = 'The BTC ETF flow check was unavailable. Farside\'s BTC ETF page was blocked before the daily flow table loaded (HTTP 403). The free public fallback for US spot BTC ETF daily net flows did not load (HTTP 503). It was not counted as a pass or a fail.';
  const unknown = assembleBrief({
    date: '2026-11-18',
    bar,
    regime: {
      score: 2,
      checks: {
        etfInflows: { status: 'unknown', detail: unavailable },
        btcQuietSupport: { status: 'pass' },
        altsNotFreefall: { status: 'fail' },
        noGreedChase: { status: 'pass' }
      }
    },
    dots,
    top: [{ name: 'LINK', kind: 'green', strength: 10 }],
    flows: [{ symbol: 'BTC', bias: 'balanced' }],
    now: new Date('2026-11-19T00:02:00.000Z')
  });
  assert.equal(unknown.builtAt, '2026-11-19T00:02:00.000Z');
  assert.equal(unknown.asOf, bar.barClose);
  assert.equal(unknown.bar, bar.bar);
  assert.equal(unknown.barClose, bar.barClose);
  assert.equal(unknown.regime.score, 2);
  assert.equal(unknown.regime.checks.etfInflows, 'unknown');
  assert.equal(unknown.regime.checks.btcQuietSupport, 'pass');
  assert.equal(unknown.etfCheckNote, unavailable);
  assert.equal(unknown.notes.includes(unavailable), true);
  assert.match(unknown.etfCheckNote, /unavailable/);
  assert.match(unknown.etfCheckNote, /blocked/);
  assert.match(unknown.etfCheckNote, /fallback/);
  assert.match(unknown.etfCheckNote, /not counted/);
  assert.doesNotMatch(unknown.notes.join(' '), /once per Mountain Time|Built once/i);
  assert.equal(unknown.dots.green, 1);
  assert.equal(unknown.dots.red, 1);

  const ready = assembleBrief({
    date: '2026-11-18', bar, dots, top: [], flows: [],
    regime: { score: 1, checks: { etfInflows: { status: 'fail', detail: { sum3Musd: -389.8 } } } }
  });
  assert.equal(ready.etfCheckNote, null);
  assert.equal(etfUnavailableNote(ready.regime && { status: 'fail' }), null);
  assert.equal(ready.regime.checks.etfInflows, 'fail');
  assert.equal(ready.notes.some(n => /unavailable/i.test(n)), false);
});

test('Farside HTML totals parse, and a negative 3-day sum fails without changing the rule', async () => {
  const rows = parseFarsideBtcHtml(FARSIDE_FAIL);
  assert.deepEqual(rows.slice(-3).map(r => r.totalMusd), [7.9, -239.9, -157.8]);
  let coinboss = 0;
  const out = await readEtfFlows({
    sleepImpl,
    fetchImpl: async (url) => {
      if (String(url).includes('coinboss')) coinboss++;
      return response(200, FARSIDE_FAIL);
    }
  });
  assert.equal(coinboss, 0);
  assert.equal(out.status, 'fail');
  assert.equal(out.rule, ETF_RULE);
  assert.equal(out.detail.source, 'farside');
  assert.equal(out.detail.sum3Musd, -389.8);
  assert.deepEqual(out.detail.last3.map(r => r.totalMusd), [7.9, -239.9, -157.8]);

  const passHtml = html([['1 Nov 2026', '1.0'], ['2 Nov 2026', '2.5'], ['3 Nov 2026', '0.5']]);
  const pass = await readEtfFlows({ sleepImpl, fetchImpl: async () => response(200, passHtml) });
  assert.equal(pass.status, 'pass');
  assert.equal(pass.detail.sum3Musd, 4);
  const flat = await readEtfFlows({ sleepImpl, fetchImpl: async () => response(200, html([['1 Nov 2026', '1.0'], ['2 Nov 2026', '1.0'], ['3 Nov 2026', '(2.0)']])) });
  assert.equal(flat.status, 'fail');
  assert.equal(flat.detail.sum3Musd, 0);
  const zero = parseCoinBossEtf({ success: true, unit: 'million_usd', dates: ['2026-11-01', '2026-11-02', '2026-11-03'], data: { '2026-11-01': { TOTAL: 1 }, '2026-11-02': { TOTAL: 1 }, '2026-11-03': { TOTAL: -2 } } });
  assert.equal(zero.reduce((s, r) => s + r.totalMusd, 0) > 0, false);
});

test('a blocked Farside page uses the public fallback totals, and a dead fallback says the check is unavailable', async () => {
  const calls = [];
  const fallback = await readEtfFlows({
    sleepImpl,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('farside')) return response(403, '<title>Just a moment...</title> cloudflare');
      return response(200, JSON.stringify({
        success: true, unit: 'million_usd',
        dates: ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
        data: {
          '2026-11-16': { TOTAL: 7.9 },
          '2026-11-17': { TOTAL: -239.9 },
          '2026-11-18': { TOTAL: -157.8 },
          '2026-11-19': { TOTAL: null }
        }
      }));
    }
  });
  assert.equal(calls.filter(u => u.includes('farside')).length, 1);
  assert.equal(calls.filter(u => u.includes('coinboss')).length, 1);
  assert.equal(fallback.status, 'fail');
  assert.equal(fallback.rule, ETF_RULE);
  assert.equal(fallback.detail.source, 'coinboss');
  assert.equal(fallback.detail.sum3Musd, -389.8);
  assert.deepEqual(fallback.detail.last3.map(r => r.date), ['2026-11-16', '2026-11-17', '2026-11-18']);

  let farsideTries = 0;
  const retried = await readEtfFlows({
    sleepImpl,
    fetchImpl: async (url) => {
      if (String(url).includes('coinboss')) throw new Error('fallback should not be called after Farside recovers');
      farsideTries++;
      if (farsideTries === 1) {
        const err = new Error('HTTP 503');
        err.status = 503;
        err.body = 'unavailable';
        throw err;
      }
      return response(200, FARSIDE_FAIL);
    }
  });
  assert.equal(farsideTries, 2);
  assert.equal(retried.status, 'fail');
  assert.equal(retried.detail.source, 'farside');

  const down = await readEtfFlows({
    sleepImpl,
    fetchImpl: async (url) => {
      if (String(url).includes('farside')) return response(403, '<html>Just a moment...</html>');
      return response(503, 'nope');
    }
  });
  assert.equal(down.status, 'unknown');
  assert.equal(down.rule, ETF_RULE);
  assert.match(down.detail, /unavailable/);
  assert.match(down.detail, /blocked/);
  assert.match(down.detail, /fallback/);
  assert.match(down.detail, /not counted/);
  assert.equal(down.detail.length < 500, true);
  const note = etfUnavailableNote(down);
  assert.equal(note, down.detail);
});
