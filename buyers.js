// buyers.js — classify traffic as known bot/monitor vs likely buyer, and anonymize payer wallets.
// No raw user-agents, IPs or wallet addresses are stored: a UA is reduced to a fixed bot name (or "buyer"),
// and a payer wallet to a truncated SHA-256 id. Bot list: Tanod's named x402 monitors (tanod.dev/learn/
// what-x402-sellers-earn.html, 13 Oct 2026) + other x402 directory/health scanners + generic crawlers.
import crypto from 'crypto';

// [name, regex]. First match wins. Names are the only thing stored, so this list bounds storage.
const KNOWN = [
    ['carbonmonitor', /carbonmonitor/i],
    ['agentrankprobe', /agentrank/i],
    ['lumiere-paycheck-prober', /lumiere|paycheck-?prober/i],
    ['toolvetprobe', /toolvet/i],
    ['x402watch', /x402-?watch/i],
    ['agent-collector', /agent-?collector/i],
    ['x402-observer', /x402-?observer/i],
    ['x402-doctor', /x402-?doctor/i],
    ['mizan', /\bmizan\b/i],
    ['easy402-indexer', /easy402/i],
    ['x402statsweb', /x402stats/i],
    ['x402scan', /x402scan/i],
    ['x402-trust', /x402-?trust/i],
    ['x402gle', /x402gle|opendexter/i],
    ['agent402', /agent402/i],
    ['tanod', /tanod/i],
    ['fizzl', /fizzl/i],
    ['bazaar-crawler', /bazaar|cdp-?(crawler|indexer|validator)/i],
    ['x402-generic-monitor', /x402.*(monitor|probe|scan|index|crawl|health|check)|(monitor|probe|scan|index|crawl|health|check).*x402/i],
    ['uptime-monitor', /uptime|pingdom|statuscake|betteruptime|better-stack|checkly|site24x7|freshping|hetrix|cron-?job|render\/health|kube-probe/i],
    ['security-scanner', /zgrab|masscan|nmap|nuclei|nikto|sqlmap|censys|shodan|expanse|internet-?measurement|l9explore|leakix/i],
    ['search-or-ai-crawler', /bot\b|bot[\/;_-]|crawl|spider|slurp|scrap|archiver|facebookexternalhit|embedly|preview|headless|lighthouse|phantomjs/i],
    ['generic-scanner', /\b(probe|scanner|indexer|monitor)\b/i],
    ['raw-http-lib', /^(go-http-client|python-urllib|java\/|libwww-perl|apache-httpclient|okhttp|winhttp|wininet)/i],
];
const MAX_UA = 512;

/** -> { cls: 'bot'|'buyer', name } . Empty UA counts as bot (real x402 SDKs and browsers send one). */
export function classifyUA(ua) {
    const s = String(ua || '').slice(0, MAX_UA).trim();
    if (!s) return { cls: 'bot', name: 'empty-ua' };
    for (const [name, re] of KNOWN) if (re.test(s)) return { cls: 'bot', name };
    return { cls: 'buyer', name: 'buyer' };
}
export const BOT_NAMES = [...KNOWN.map(k => k[0]), 'empty-ua', 'grader-wallet'];

/** Truncated, salted-by-purpose SHA-256 of a lowercased 0x address. Not reversible to a wallet list. */
export function payerId(addr) {
    const a = String(addr || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
    return crypto.createHash('sha256').update('gw8-payer:' + a).digest('hex').slice(0, 16);
}

// Optional: GW8's own seeding wallets (public addresses, comma-separated; not a secret) -> counted as "self".
let ownIds = null;
export function isOwnPayer(pid) {
    if (!ownIds) ownIds = new Set(String(process.env.GW8_OWN_WALLETS || '').split(',').map(payerId).filter(Boolean));
    return !!pid && ownIds.has(pid);
}

/** Payer address from a verified x402 v2 EIP-3009 payload and/or facilitator settle response. */
export function payerFrom(paymentPayload, settleData) {
    const s = settleData && typeof settleData.payer === 'string' ? settleData.payer : null;
    const a = paymentPayload && paymentPayload.payload && paymentPayload.payload.authorization && paymentPayload.payload.authorization.from;
    return s || (typeof a === 'string' ? a : null);
}

// Grader rule (Tanod): a wallet that pays many different routes within an hour is a tester, not a buyer.
export const GRADER_ROUTES_PER_HOUR = 8;
