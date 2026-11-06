const OUTPUT_FORMATS = new Set(['markdown', 'text', 'both']);
const MAX_PAGES_CAP = 200;
const MAX_CRAWL_DEPTH = 2;

export function normalizeStartUrls(value) {
  if (!Array.isArray(value)) return [];
  const urls = [];
  const seen = new Set();
  for (const entry of value) {
    const raw = typeof entry === 'string' ? entry : entry?.url;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let parsed;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new Error(`startUrls contains an invalid URL: ${raw}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`startUrls only accepts http and https URLs: ${raw}`);
    }
    parsed.hash = '';
    const href = parsed.href;
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

export function normalizeInput(raw = {}) {
  const startUrls = normalizeStartUrls(raw.startUrls);
  if (!startUrls.length) {
    throw new Error('startUrls must contain at least one http(s) URL.');
  }

  let crawlDepth = Number.isFinite(raw.crawlDepth) ? Math.trunc(raw.crawlDepth) : 0;
  if (crawlDepth < 0) crawlDepth = 0;
  if (crawlDepth > MAX_CRAWL_DEPTH) crawlDepth = MAX_CRAWL_DEPTH;

  let maxPages = Number.isFinite(raw.maxPages) ? Math.trunc(raw.maxPages) : 10;
  if (maxPages < 1) maxPages = 1;
  if (maxPages > MAX_PAGES_CAP) maxPages = MAX_PAGES_CAP;

  const outputFormat = OUTPUT_FORMATS.has(raw.outputFormat) ? raw.outputFormat : 'markdown';
  const removeSelectors = Array.isArray(raw.removeSelectors)
    ? raw.removeSelectors.filter((selector) => typeof selector === 'string' && selector.trim()).map((selector) => selector.trim())
    : [];

  return {
    startUrls,
    crawlDepth,
    maxPages,
    includeLinks: Boolean(raw.includeLinks),
    outputFormat,
    removeSelectors,
    useBrowserFallback: raw.useBrowserFallback === undefined ? true : Boolean(raw.useBrowserFallback),
    respectRobotsTxt: raw.respectRobotsTxt === undefined ? true : Boolean(raw.respectRobotsTxt),
  };
}
