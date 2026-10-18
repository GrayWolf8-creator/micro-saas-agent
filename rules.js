// rules.js — crypto rule-change feed (CFTC + SEC). Public, keyless sources only. Signal only.
// Sources: Federal Register API, reginfo.gov (Unified Agenda presence per RIN), SEC press RSS, CFTC press RSS.
// Each source is labeled ok/unavailable per call; a failed source is left empty, never filled with stale rows.
import { redis, hasRedis } from './alerts.js';

const UA = { 'User-Agent': 'GW8-Signal/1.0 (+https://micro-saas-agent.onrender.com)' };
const FR = 'https://www.federalregister.gov/api/v1/documents.json';
const RSS = { secPress: 'https://www.sec.gov/news/pressreleases.rss', cftcPress: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml' };
const OIRA = rin => `https://www.reginfo.gov/public/do/eAgendaViewRule?RIN=${rin}`;
const TERMS = ['crypto', 'digital asset', 'stablecoin', 'tokenization', 'blockchain', 'virtual currency'];
const KW = /crypto|digital[- ]asset|stablecoin|tokeni[sz]|blockchain|bitcoin|virtual currenc|decentralized finance|\bdefi\b|distributed ledger/i;
const WINDOW_DAYS = 90, CACHE_MS = 15 * 60e3, SEEN = 'gw8:rules_seen', SINCE = 'gw8:rules_since';
const mem = { seen: {}, since: null };
const st = { lastRun: null, sources: {} };
let cache = null, inflight = null;
const DISCLAIMER = 'informational only, not legal or financial advice';
const get = async (u, ms = 15000) => { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error('HTTP ' + r.status); return r; };
const fail = e => `unavailable from our host (${e.name === 'TimeoutError' ? 'timeout' : String(e.message || 'fetch failed').slice(0, 40)})`;

export function docType(type, action) {
    const a = String(action || '').toLowerCase();
    if (/advance(d)? notice of proposed rulemaking/.test(a)) return 'ANPRM';
    if (type === 'Proposed Rule') return 'NPRM';
    if (type === 'Rule') return /interim/.test(a) ? 'interim final' : 'final';
    return 'notice';
}
async function federalRegister(since) {
    const fields = ['title', 'type', 'action', 'publication_date', 'regulation_id_numbers', 'comments_close_on', 'html_url', 'agencies', 'document_number', 'abstract'];
    const q = term => FR + '?' + [['per_page', '100'], ['order', 'newest'], ['conditions[term]', term], ['conditions[publication_date][gte]', since],
        ['conditions[agencies][]', 'commodity-futures-trading-commission'], ['conditions[agencies][]', 'securities-and-exchange-commission'], ...fields.map(f => ['fields[]', f])]
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const res = await Promise.allSettled(TERMS.map(t => get(q(t)).then(r => r.json())));
    if (res.every(r => r.status === 'rejected')) throw res[0].reason;
    const by = {};
    for (const r of res) if (r.status === 'fulfilled') for (const d of r.value.results || []) by[d.document_number] = d;
    const rows = Object.values(by).map(d => {
        const ag = (d.agencies || []).map(a => a.slug === 'commodity-futures-trading-commission' ? 'CFTC' : a.slug === 'securities-and-exchange-commission' ? 'SEC' : a.name).filter(Boolean);
        const kind = docType(d.type, d.action), titleHit = KW.test(d.title + ' ' + (d.abstract || ''));
        return { date: d.publication_date, agency: [...new Set(ag)].join('/'), docType: kind, title: d.title, rin: (d.regulation_id_numbers || [])[0] || null,
            commentDeadline: d.comments_close_on || null, link: d.html_url, source: 'federal-register', documentNumber: d.document_number,
            match: titleHit ? 'title/abstract' : 'full text only', sroFiling: /^Self-Regulatory Organizations/.test(d.title) };
    });
    return { rows, partial: res.some(r => r.status === 'rejected') };
}
async function rss(name, url, since) {
    const s = await (await get(url)).text();
    const tag = (i, t) => ((i.match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1] || '').trim();
    return [...s.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({ title: tag(m[1], 'title'), link: tag(m[1], 'link'), date: new Date(tag(m[1], 'pubDate')).toISOString().slice(0, 10), desc: tag(m[1], 'description') }))
        .filter(x => KW.test(x.title + ' ' + x.desc) && x.date >= since)
        .map(x => ({ date: x.date, agency: name === 'secPress' ? 'SEC' : 'CFTC', docType: 'press', title: x.title, rin: null, commentDeadline: null, link: x.link, source: name }));
}
async function oira(rins) {
    const out = {};
    for (const rin of rins.slice(0, 12)) {
        try {
            let t = await (await get(OIRA(rin), 10000)).text();
            t = t.replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            const m = t.match(/published in the following Unified Agenda\(s\):\s*(.*?)\s*Reginfo\.gov/);
            out[rin] = /has not been published in a Unified Agenda/.test(t) ? { unifiedAgenda: [], note: 'not in a published Unified Agenda yet' } : m ? { unifiedAgenda: (m[1].match(/(?:Spring|Fall)\s\d{4}|\b\d{4}\b/g) || []).slice(0, 4) } : { status: 'unparsed' };
            out[rin].link = OIRA(rin);
        } catch (e) { out[rin] = { status: fail(e) }; }
    }
    return out;
}
// ---- append-only first-seen (Upstash HSETNX; memory fallback) ----
async function seenAll() { if (!hasRedis()) return { ...mem.seen }; const a = await redis(['HGETALL', SEEN]) || []; const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; }
async function markSeen(k, v) { if (hasRedis()) await redis(['HSETNX', SEEN, k, v]); else if (mem.seen[k] == null) mem.seen[k] = v; }
async function since() { if (hasRedis()) { await redis(['SET', SINCE, new Date().toISOString(), 'NX']); return redis(['GET', SINCE]); } return (mem.since ||= new Date().toISOString()); }

async function build() {
    const start = new Date(Date.now() - WINDOW_DAYS * 86400e3).toISOString().slice(0, 10), sources = {};
    const [fr, sec, cftc] = await Promise.allSettled([federalRegister(start), rss('secPress', RSS.secPress, start), rss('cftcPress', RSS.cftcPress, start)]);
    sources.federalRegister = fr.status === 'fulfilled' ? (fr.value.partial ? 'partial' : 'ok') : fail(fr.reason);
    sources.secPressRss = sec.status === 'fulfilled' ? 'ok' : fail(sec.reason);
    sources.cftcPressRss = cftc.status === 'fulfilled' ? 'ok' : fail(cftc.reason);
    let rows = [...(fr.value?.rows || []), ...(sec.value || []), ...(cftc.value || [])];
    if (!rows.length && Object.values(sources).every(s => s.startsWith('unavailable'))) return { error: 'upstream data unavailable, retry shortly', sources };
    // Stage history per RIN from the Federal Register window (oldest -> newest)
    const hist = {};
    for (const r of rows.filter(r => r.rin).sort((a, b) => a.date.localeCompare(b.date))) (hist[r.rin] ||= []).push({ date: r.date, docType: r.docType });
    // First-seen + stage-change flags
    let liveSince = null, seen = {}, storeOk = true;
    try { liveSince = await since(); seen = await seenAll(); } catch { storeOk = false; }
    const now = new Date().toISOString(), baseline = storeOk && !Object.keys(seen).length;
    for (const r of rows) {
        const key = r.rin ? `rin:${r.rin}|${r.docType}` : `doc:${r.documentNumber || r.link}`;
        r.firstSeenByGw8 = seen[key] ? JSON.parse(seen[key]).t : (storeOk ? now : null);
        if (storeOk && !seen[key]) { await markSeen(key, JSON.stringify({ t: now, baseline })).catch(() => {}); seen[key] = JSON.stringify({ t: now, baseline }); }
        const h = r.rin ? hist[r.rin] : null, i = h ? h.findIndex(x => x.date === r.date && x.docType === r.docType) : -1;
        const prior = r.rin ? Object.keys(seen).filter(k => k.startsWith(`rin:${r.rin}|`) && k !== key).map(k => k.split('|')[1]) : [];
        r.stageChange = r.docType === 'press' ? null : (i > 0 && h[i - 1].docType !== r.docType) ? { from: h[i - 1].docType, to: r.docType, basis: 'federal-register history' }
            : prior.length ? { from: prior.join(','), to: r.docType, basis: 'gw8 first-seen log' } : (r.rin ? { from: null, to: r.docType, basis: 'earliest stage seen (no prior stage in window or log)' } : null);
        delete r.documentNumber;
    }
    const related = rows.filter(r => r.match === 'full text only'); rows = rows.filter(r => r.match !== 'full text only');
    rows.sort((a, b) => b.date.localeCompare(a.date) || (a.docType === 'press') - (b.docType === 'press'));
    const rins = [...new Set(rows.filter(r => r.rin && r.match !== 'full text only').map(r => r.rin))];
    const ag = await oira(rins);
    const okOira = Object.values(ag).filter(x => !x.status || x.status === 'unparsed').length;
    sources.reginfoUnifiedAgenda = !rins.length ? 'not needed' : okOira ? (okOira < rins.length ? 'partial' : 'ok') : 'unavailable from our host';
    for (const r of rows) if (r.rin && ag[r.rin]) r.oira = ag[r.rin];
    const openComments = rows.filter(r => r.commentDeadline && r.commentDeadline >= now.slice(0, 10)).map(r => ({ rin: r.rin, agency: r.agency, docType: r.docType, title: r.title, commentDeadline: r.commentDeadline, link: r.link }));
    Object.assign(st, { lastRun: now, sources });
    return {
        asOf: now, windowDays: WINDOW_DAYS, liveSince, store: hasRedis() ? 'upstash-redis' : 'memory (resets on restart)', sourceStatus: sources,
        count: rows.length, openComments, rows: rows.slice(0, 150), truncated: rows.length > 150,
        relatedFullTextMatches: { note: 'crypto term only in the document body; often tangential', count: related.length, items: related.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25).map(r => ({ date: r.date, agency: r.agency, docType: r.docType, title: r.title, rin: r.rin, commentDeadline: r.commentDeadline, link: r.link })) },
        notes: [
            'docType comes from the Federal Register document type + action line (ANPRM / NPRM / interim final / final / notice); press = agency press release.',
            'rows = crypto term in the title/abstract, or crypto press releases. Documents where the term appears only in the body are listed separately under relatedFullTextMatches (often tangential). sroFiling = exchange rule filing notices (e.g. crypto ETP listings).',
            `stageChange: from Federal Register history inside the ${WINDOW_DAYS}-day window, or from our append-only first-seen log (started ${liveSince}). Stages before the window or before liveSince are not known.`,
            'oira = which Unified Agendas list the RIN on reginfo.gov (presence only, not a stage).',
            'A source marked unavailable is left empty for this call; no stale rows are substituted.'
        ],
        sources: { federalRegister: FR, secPress: RSS.secPress, cftcPress: RSS.cftcPress, reginfo: 'https://www.reginfo.gov/public/do/eAgendaViewRule?RIN=' },
        disclaimer: DISCLAIMER
    };
}
export async function getRules() {
    if (cache && Date.now() - cache.t < CACHE_MS) return { ...cache.data, cached: true };
    if (!inflight) inflight = build().then(d => { if (!d.error) cache = { t: Date.now(), data: d }; return d; }).finally(() => { inflight = null; });
    try { return await inflight; } catch { return { error: 'upstream data unavailable, retry shortly' }; }
}
export async function getRulesStatus() {
    const probe = async u => { try { await get(u, 8000); return 'ok'; } catch (e) { return fail(e); } };
    const [fr, sec, cftc, oi] = await Promise.all([probe(FR + '?per_page=1'), probe(RSS.secPress), probe(RSS.cftcPress), probe(OIRA('3038-AF80'))]);
    return { free: true, lastRun: st.lastRun, sources: { federalRegister: fr, secPressRss: sec, cftcPressRss: cftc, reginfoUnifiedAgenda: oi }, lastRunSources: st.sources,
        note: 'Free health check only (no rows). Paid feed: GET /api/rules ($0.02).' };
}
