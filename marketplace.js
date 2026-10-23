// marketplace.js — card-paid channels (RapidAPI, Apify) for the same signal-only data.
// Buyers pay the marketplace by card; the marketplace forwards each call here with a shared secret header.
// - RapidAPI: its Runtime adds X-RapidAPI-Proxy-Secret to every request (value from RapidAPI Studio > Gateway/Security).
// - Apify: GW8's own Actor sends X-GW8-Partner-Key (GW8 generates it; stored as a secret env var on Apify + Render).
// Secrets are read from process.env only, compared in constant time, never logged or echoed.
// A channel whose env var is unset is OFF (fails closed with 503). No x402, no wallet, no payout logic here:
// marketplace billing happens on the marketplace side. Signal only, not financial advice.
import crypto from 'crypto';
import { getCoin, getDots, getHistory, getRegime, COINS } from './Signal.js';
import { getVerdict, validVerdictInput, VERDICT_CHAINS, getFlows, getBrief, getBriefTeaser } from './upgrades.js';
import { getRwa } from './rwa.js';
import { getKrakenListings } from './kraken.js';
import { getRules } from './rules.js';
import { getGovContracts, validGovFilters, GOV_SECTORS } from './gov.js';

export const CHANNELS = {
  rapidapi: { env: 'RAPIDAPI_PROXY_SECRET', header: 'x-rapidapi-proxy-secret', label: 'MARKETPLACE_RAPIDAPI' },
  apify: { env: 'APIFY_PARTNER_KEY', header: 'x-gw8-partner-key', label: 'MARKETPLACE_APIFY' }
};
const PER_MINUTE = Number(process.env.MARKETPLACE_MAX_PER_MINUTE || 300); // per channel, safety cap only
const DISCLAIMER = 'Signal only, not financial advice. Public-data derived; no trading or execution.';

const digest = s => crypto.createHash('sha256').update(String(s)).digest();
function secretOk(expected, given) {
  if (!expected || !given) return false;
  return crypto.timingSafeEqual(digest(expected), digest(given)); // equal-length digests, constant time
}

const windows = new Map(); // channel -> { minute, n }
function underCap(ch) {
  const minute = Math.floor(Date.now() / 60000);
  const w = windows.get(ch);
  if (!w || w.minute !== minute) { windows.set(ch, { minute, n: 1 }); return true; }
  w.n += 1;
  return w.n <= PER_MINUTE;
}

/** Gate: /mkt/:channel/* only answers when the channel's shared secret matches. */
export function marketplaceGate(req, res, next) {
  const ch = CHANNELS[String(req.params.channel || '').toLowerCase()];
  if (!ch) return res.status(404).json({ error: 'unknown channel' });
  const expected = process.env[ch.env];
  if (!expected) return res.status(503).json({ error: 'channel not enabled' });
  if (!secretOk(expected, req.headers[ch.header])) {
    return res.status(403).json({ error: 'forbidden: call this API through its marketplace listing, or pay per call with x402 at /api/*' });
  }
  if (!underCap(req.params.channel)) return res.status(429).set('Retry-After', '60').json({ error: 'rate limited, retry in a minute' });
  res.locals.gw8Channel = ch.label;
  next();
}

// Uniform envelope. Upstream failure -> 503 so the Apify Actor does not charge (it only charges on 200).
async function serve(res, deliver) {
  let out;
  try { out = await deliver(); } catch (e) { out = { error: 'upstream data unavailable, retry shortly' }; }
  if (!out || out.error) return res.status(503).json({ error: (out && out.error) || 'upstream data unavailable, retry shortly' });
  return res.json({ status: 'success', accessType: res.locals.gw8Channel, timestamp: new Date().toISOString(), signal: out, disclaimer: DISCLAIMER });
}
const symOk = s => COINS.includes(s);

/** Mount the card-paid routes. Paths mirror /api/* so docs stay simple. Subscriptions and the day pass stay x402-only. */
export function mountMarketplace(app, signResponses) {
  const base = '/mkt/:channel';
  const gated = signResponses ? [marketplaceGate, signResponses] : [marketplaceGate];
  app.get(`${base}/brief/teaser`, gated, (req, res) => serve(res, getBriefTeaser));
  app.get(`${base}/brief`, gated, (req, res) => serve(res, getBrief));
  app.get(`${base}/govcontracts`, gated, (req, res) => {
    const f = { ticker: req.query.ticker ? String(req.query.ticker) : undefined, sector: req.query.sector ? String(req.query.sector) : undefined, q: req.query.q ? String(req.query.q) : undefined };
    const bad = validGovFilters(f);
    if (bad) return res.status(400).json({ error: bad, sectors: GOV_SECTORS });
    return serve(res, () => getGovContracts(f));
  });
  app.get(`${base}/flows/:symbol`, gated, (req, res) => {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!symOk(sym)) return res.status(404).json({ error: 'unknown symbol', supported: COINS });
    return serve(res, () => getFlows(sym));
  });
  app.get(`${base}/coin/:symbol`, gated, (req, res) => {
    const sym = String(req.params.symbol || '').toUpperCase();
    if (!symOk(sym)) return res.status(404).json({ error: 'unknown symbol', supported: COINS });
    return serve(res, () => getCoin(sym));
  });
  app.get(`${base}/regime`, gated, (req, res) => serve(res, getRegime));
  app.get(`${base}/dots`, gated, (req, res) => serve(res, getDots));
  app.get(`${base}/history`, gated, (req, res) => {
    const pair = req.query.pair ? String(req.query.pair).toUpperCase().replace(/\/USD$/, '') : null;
    if (pair && !symOk(pair)) return res.status(404).json({ error: 'unknown pair', supported: COINS });
    return serve(res, () => getHistory(pair));
  });
  app.get(`${base}/verdict/:chain/:address`, gated, (req, res) => {
    const chain = String(req.params.chain).toLowerCase(), address = String(req.params.address);
    const bad = validVerdictInput(chain, address);
    if (bad) return res.status(400).json({ error: bad, chains: Object.keys(VERDICT_CHAINS) });
    return serve(res, () => getVerdict(chain, address));
  });
  app.get(`${base}/rwa`, gated, (req, res) => serve(res, getRwa));
  app.get(`${base}/kraken/listings`, gated, (req, res) => serve(res, getKrakenListings));
  app.get(`${base}/rules`, gated, (req, res) => serve(res, getRules));
  app.all(`${base}/*rest`, marketplaceGate, (req, res) => res.status(404).json({ error: 'unknown endpoint' }));
}
