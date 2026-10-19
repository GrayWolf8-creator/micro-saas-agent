// track.js — FREE public track record of the WaveTrend band-dot signals the API sells.
// Two clearly separated sections:
//  1. backtest (simulated): every dot in the rolling 90-day window recomputed from Kraken 4h closes.
//  2. live log: each band dot appended (once) when the running service first sees it, from LIVE_SINCE on.
// Prices: Kraken public 4h OHLC (same source as the signals). Nothing is invented; unelapsed horizons are null.
import { getWaveTrend } from './Signal.js';
import { redis, hasRedis } from './alerts.js';

const LOG = 'gw8:track_log', SEEN = 'gw8:track_seen', SINCE = 'gw8:track_since';
const H = [['1d', 6, 'fwd24hPct'], ['7d', 42, 'fwd7dPct'], ['30d', 180, 'fwd30dPct']];
const HIDE_MS = 24 * 3600 * 1000; // newest 24h of dots stay paid (/api/dots); the track list shows older ones
export const WARN_30D = '30-day results mostly reflect overall market trend in this window, not signal skill; signals overlap and are not independent.';
const MEASURES = { primary: ['1d', '7d'], secondary: ['30d'], note30d: WARN_30D };
const r2 = v => v == null ? null : Math.round(v * 100) / 100;
const mem = { log: [], seen: new Set(), since: null };
const key = d => `${d.name}|${d.kind}|${d.bar}`;

export async function logDots(wt) {
  const dots = wt.bandDots || []; let added = 0;
  for (const d of dots) {
    const k = key(d), rec = { name: d.name, kind: d.kind, band: d.band, bar: d.bar, wt1: d.wt1, close: d.close, loggedAt: new Date().toISOString() };
    if (hasRedis()) {
      try {
        if (await redis(['SADD', SEEN, k]) === 1) {
          await redis(['RPUSH', LOG, JSON.stringify(rec)]);
          await redis(['LTRIM', LOG, -5000, -1]); // cap live log; /track still reads the kept tail
          added++;
        }
        await redis(['SETNX', SINCE, rec.loggedAt]);
      } catch (e) { console.error('[track] log failed', e.message); }
    } else if (!mem.seen.has(k)) { mem.seen.add(k); mem.log.push(rec); if (mem.log.length > 5000) mem.log = mem.log.slice(-5000); mem.since ||= rec.loggedAt; added++; }
  }
  return { added };
}
async function readLog() {
  if (hasRedis()) {
    try { const [raw, since] = await Promise.all([redis(['LRANGE', LOG, 0, -1]), redis(['GET', SINCE])]); return { store: 'upstash-redis', since, log: (raw || []).map(x => JSON.parse(x)) }; }
    catch (e) { return { store: 'upstash-redis (read failed)', since: null, log: [], error: true }; }
  }
  return { store: 'memory (resets on restart)', since: mem.since, log: mem.log };
}

const hit = (kind, v) => kind === 'green' ? v > 0 : v < 0;
function summarize(rows) {
  const out = {};
  for (const kind of ['green', 'red']) for (const band of ['outer', 'inner', 'all']) {
    const s = rows.filter(x => x.kind === kind && (band === 'all' || x.band === band)); const o = { signals: s.length };
    for (const [h] of H) {
      const v = s.map(x => x.fwd[h]).filter(x => x != null).sort((a, b) => a - b);
      if (!v.length) { o[h] = { n: 0 }; continue; }
      const hits = v.filter(x => hit(kind, x)).length;
      o[h] = { n: v.length, hits, misses: v.length - hits, hitRatePct: r2(hits / v.length * 100), avgMovePct: r2(v.reduce((a, b) => a + b, 0) / v.length), medianMovePct: r2(v[v.length >> 1]), worstPct: r2(kind === 'green' ? v[0] : v[v.length - 1]), bestPct: r2(kind === 'green' ? v[v.length - 1] : v[0]) };
    }
    out[`${kind}_${band}`] = o;
  }
  return out;
}
const row = (d, fwd) => ({ date: d.bar, coin: d.name, direction: d.kind === 'green' ? 'up (green)' : 'down (red)', kind: d.kind, band: d.band, entryPrice: d.close, fwd,
  result: Object.fromEntries(H.map(([h]) => [h, fwd[h] == null ? 'pending' : hit(d.kind, fwd[h]) ? 'hit' : 'miss'])) });

export async function getTrack() {
  const wt = await getWaveTrend(); const now = Date.now();
  // Backtest (simulated)
  const bt = (wt.history || []).filter(x => now - Date.parse(x.bar) > HIDE_MS)
    .map(x => row({ name: x.pair.replace('/USD', ''), kind: x.kind, band: x.band, bar: x.bar, close: x.close }, { '1d': x.fwd24hPct, '7d': x.fwd7dPct ?? null, '30d': x.fwd30dPct ?? null }))
    .sort((a, b) => b.date.localeCompare(a.date));
  // Live log, evaluated against current Kraken closes
  const L = await readLog();
  const live = L.log.filter(x => now - Date.parse(x.bar) > HIDE_MS).map(x => {
    const s = (wt.series || {})[x.name] || []; const t0 = Date.parse(x.bar) / 1000; const i = s.findIndex(p => p[0] === t0); const fwd = {};
    for (const [h, k] of H) fwd[h] = i >= 0 && i + k < s.length ? r2((s[i + k][1] / x.close - 1) * 100) : null;
    return { ...row(x, fwd), loggedAt: x.loggedAt };
  }).sort((a, b) => b.date.localeCompare(a.date));
  return {
    asOf: wt.asOf, free: true,
    methodology: [
      'Signals: LazyBear WaveTrend 10/21/4 on Kraken 4h closed candles, 66 USD pairs. Green dot = wt1 crosses above wt2 at wt1 <= -53 (outer <= -60); red dot = cross below at wt1 >= +53 (outer >= +60). Same rules the paid endpoints use.',
      'Entry price = close of the 4h signal candle. Forward move = Kraken close 6 / 42 / 180 candles later (1d / 7d / 30d). Green is a hit if price is higher, red is a hit if price is lower. No fees, slippage, stops or position sizing.',
      'Backtest (simulated) = signals recomputed over the rolling ~90-day Kraken window, with knowledge of the full candle series (no look-ahead in the signal itself, but it is not a record of what was published at the time).',
      'Live log = each dot appended once, when the running service first saw it (loggedAt). Starts at liveSince; it is short until it accrues. If the service was down, dots from that gap may be logged late or missed.',
      'Signals from the last 24h are not listed here (they are the paid product); they appear once older. 30d results exist only for signals at least 30 days old. Misses and weak results are shown as-is.',
      'Caution reading the hit rates: signals overlap in time and across coins that move together, so they are not independent; longer horizons (especially 30d) mostly reflect the one market trend inside the 90-day window (e.g. a broad rally lifts every green and sinks every red). Treat 1d/7d as more informative than 30d until the live log is long.',
      'Past performance is not indicative of future results. Signal only, not financial advice.'
    ],
    backtest: { label: 'backtest (simulated), rolling ~90 days', measures: MEASURES, summary: summarize(bt), count: bt.length, signals: bt.slice(0, 300), truncated: bt.length > 300 },
    live: { label: L.since ? `live-logged since ${L.since}` : 'live log not started yet', measures: MEASURES, liveSince: L.since, store: L.store, summary: summarize(live), count: live.length, signals: live.slice(0, 300), truncated: live.length > 300, pendingNewest24h: L.log.length - live.length },
    disclaimer: 'signal only, past performance is not indicative of future results, not financial advice'
  };
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = v => v == null ? '–' : (v > 0 ? '+' : '') + v + '%';
function sumTable(sm) {
  const rows = Object.entries(sm).filter(([, o]) => o.signals).map(([k, o]) => `<tr><td>${esc(k.replace('_', ' '))}</td><td>${o.signals}</td>${H.map(([h]) => { const x = o[h], c = h === '30d' ? ' class="dim"' : ''; return x.n ? `<td${c}>${x.hitRatePct}% <small>(${x.hits} hit / ${x.misses} miss, avg ${pct(x.avgMovePct)})</small></td>` : `<td${c}>–</td>`; }).join('')}</tr>`).join('');
  return `<table><tr><th>signal</th><th>count</th><th>1d hit (primary measure)</th><th>7d hit (primary measure)</th><th class="dim">30d hit ⚠ (see warning)</th></tr>${rows || '<tr><td colspan=5>no signals yet</td></tr>'}</table><p class="warn">⚠ 30d: ${esc(WARN_30D)}</p>`;
}
function list(sig) {
  const cls = r => r === 'hit' ? 'h' : r === 'miss' ? 'm' : '';
  return `<table><tr><th>date (UTC)</th><th>coin</th><th>dot</th><th>entry</th><th>1d (primary)</th><th>7d (primary)</th><th class="dim">30d ⚠</th></tr>${sig.map(s => `<tr><td>${esc(s.date.slice(0, 16).replace('T', ' '))}</td><td>${esc(s.coin)}</td><td>${esc(s.kind)} ${esc(s.band)}</td><td>${esc(s.entryPrice)}</td>${H.map(([h]) => `<td class="${cls(s.result[h])}${h === '30d' ? ' dim' : ''}">${pct(s.fwd[h])}</td>`).join('')}</tr>`).join('')}</table>`;
}
export function renderTrack(t) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GW8 Signal API – Track record</title>
<style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#e5e7eb;margin:0;padding:12px;max-width:900px}h1{font-size:1.3em}h2{font-size:1.1em;margin-top:1.4em}table{border-collapse:collapse;width:100%;font-size:.85em;display:block;overflow-x:auto}td,th{border-bottom:1px solid #1f2937;padding:4px 6px;text-align:left;white-space:nowrap}.h{color:#22c55e}.m{color:#ef4444}small,.n{color:#9ca3af}a{color:#60a5fa}.dim{opacity:.6;font-size:.9em}.warn{color:#fbbf24;font-size:.85em;margin:.3em 0 .8em}li{margin:.3em 0;font-size:.9em}</style></head><body>
<h1>GW8 Signal API: honest track record</h1><p class="n">Free. Updated ${esc(t.asOf)}. Includes misses. Green (up) and red (down) dots are shown the same way. Primary measures: 1d and 7d. <a href="/api/track">JSON</a> · <a href="/llms.txt">docs</a></p>
<h2>Live log: ${esc(t.live.label)}</h2><p class="n">${t.live.count} signals older than 24h logged so far (${esc(t.live.store)}).</p>${sumTable(t.live.summary)}${t.live.count ? list(t.live.signals.slice(0, 100)) : ''}
<h2>Backtest (simulated): rolling ~90 days</h2>${sumTable(t.backtest.summary)}<p class="n">Latest ${Math.min(150, t.backtest.count)} of ${t.backtest.count} signals (green = hit, red = miss):</p>${list(t.backtest.signals.slice(0, 150))}
<h2>Method</h2><ul>${t.methodology.map(m => `<li>${esc(m)}</li>`).join('')}</ul><p class="n">${esc(t.disclaimer)}</p></body></html>`;
}
