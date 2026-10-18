// dod.js — U.S. Department of War (defense.gov / war.gov) daily contract announcements (awards >= $7.5M).
// Public pages: RSS index + one article per business day. Parsed text only; no invented values.
const RSS = 'https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=400&Site=945&max=20';
const HDRS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };
const get = async url => { const r = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—' };
const clean = h => h.replace(/<[^>]+>/g, '').replace(/&(#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCharCode(+e.slice(1)) : (ENT[e.toLowerCase()] ?? m)).replace(/\s+/g, ' ').trim();
const CN = /\b[A-Z0-9]{6}-?\d{2}-?[A-Z]-?[A-Z0-9]{4,5}\b/g;
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const toIso = s => { const m = /([A-Z][a-z]{2,4})\.? (\d{1,2}), (\d{4})/.exec(s || ''); if (!m || MON[m[1].toLowerCase().slice(0, m[1].toLowerCase() === 'sept' ? 4 : 3)] == null) return null; return new Date(Date.UTC(+m[3], MON[m[1].toLowerCase().slice(0, 3)], +m[2])).toISOString().slice(0, 10); };
export const normCn = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = /<link>\s*([^<\s]+)\s*<\/link>/.exec(m[1])?.[1]; const title = clean(/<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] || ''); const pub = /<pubDate>([^<]+)<\/pubDate>/.exec(m[1])?.[1];
    if (link && /Contracts for/i.test(title)) items.push({ link, title, date: toIso(title) || (pub ? new Date(pub).toISOString().slice(0, 10) : null) });
  }
  return items;
}

// Returns one row per award paragraph (CORRECTION/UPDATE notices and footnotes skipped).
export function parseArticle(html, annDate, url) {
  const i = html.indexOf('<div class="body">'); if (i < 0) return [];
  const body = html.slice(i, html.indexOf('<div class="body">', i + 10) > 0 ? html.indexOf('<div class="body">', i + 10) : undefined);
  const rows = []; let branch = null;
  for (const m of body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const raw = m[1], t = clean(raw); if (!t) continue;
    if (/^<strong>[^<]+<\/strong>$/.test(raw.trim()) && t === t.toUpperCase()) { branch = t; continue; }
    if (/^(CORRECTION|UPDATE|\*)/.test(t)) continue;
    const amt = /\$([\d,]{4,})/.exec(t); if (!amt) continue;
    const head = t.split(/\s(?:was|is|were|are|has been|have been) (?:awarded|being awarded|added)/)[0];
    const company = head.split(',')[0].replace(/\*+/g, '').trim();
    const location = head.includes(',') ? head.slice(head.indexOf(',') + 1).replace(/\([^)]*\)/g, '').replace(/\*+/g, '').replace(/;.*$/, '').replace(/,\s*$/, '').trim() : null;
    const pre = t.slice(Math.max(0, amt.index - 40), amt.index).toLowerCase();
    const cns = [...new Set(t.match(CN) || [])];
    rows.push({ annDate, awardedDate: toIso(/\(Awarded (?:on )?([^)]+)\)/i.exec(t)?.[1]) || annDate, branch, company, location, recipientText: head.slice(0, 300),
      amountUsd: +amt[1].replace(/,/g, ''), amountType: /ceiling|not-to-exceed|maximum/.test(pre + ' ' + t.slice(amt.index, amt.index + 40).toLowerCase()) ? 'ceiling' : /modification/.test(t.slice(amt.index, amt.index + 80)) ? 'modification' : 'announced value',
      contractNumber: cns[0] || null, contractNumbers: cns, multipleAwardees: /; and |were awarded|have been awarded/.test(t.slice(0, 600)),
      contractingActivity: (() => { const k = t.search(/,? is the contracting activity/); if (k < 0) return null; const parts = t.slice(0, k).split(/(?<=[a-z0-9)%])\.\s+/); return parts[parts.length - 1].replace(/^\(?Awarded[^)]*\)\.?\s*/i, '').trim().slice(0, 160) || null; })(),
      description: t.slice(0, 400), link: url });
  }
  return rows;
}

export async function fetchDod(days = 14, now = Date.now()) {
  const items = parseRss(await get(RSS)); const cutoff = new Date(now - days * 86400000).toISOString().slice(0, 10);
  const recent = items.filter(x => x.date && x.date >= cutoff); const rows = [], failed = [];
  for (const it of recent) { try { rows.push(...parseArticle(await get(it.link), it.date, it.link)); } catch (e) { failed.push(it.link); } }
  if (recent.length && failed.length === recent.length) throw new Error('all articles blocked/failed');
  return { rows, days: recent.map(x => x.date), failed };
}
export const DOD_SOURCES = [RSS, 'https://www.war.gov/News/Contracts/'];
