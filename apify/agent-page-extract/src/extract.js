import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';

const DEFAULT_REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'nav',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.nav',
  '.navbar',
  '.menu',
  '.footer',
  '.site-footer',
  '.site-header',
  '.sidebar',
  '.cookie',
  '.cookie-banner',
  '.cookie-consent',
  '#cookie-banner',
  '#onetrust-banner-sdk',
  '.ads',
  '.ad',
  '.advert',
  '.advertisement',
  '.ad-container',
  '[aria-label*="cookie" i]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[class*="advert" i]',
  '[id*="advert" i]',
];

const SKIP_PATH = /\.(pdf|zip|gz|rar|7z|png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|mp4|mp3|wav|woff2?|ttf|eot|xml|json|rss|atom|dmg|exe|apk|csv)$/i;
const BOT_CHALLENGE = /cf-browser-verification|cf-challenge|attention required|verify you are human|just a moment\.\.\.|enable javascript and cookies to continue/i;
const JS_SHELL = /id=["'](?:root|app|__next)["']|you need to enable javascript|enable javascript|ng-app|data-reactroot|__next_data__|id=["']__nuxt["']/i;

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.remove(['script', 'style', 'noscript', 'iframe']);

function parseDocument(html, url) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  return new JSDOM(String(html || ''), {
    url,
    virtualConsole,
    contentType: 'text/html',
  }).window.document;
}

function metaContent(document, selector) {
  return document.querySelector(selector)?.getAttribute('content')?.replace(/\s+/g, ' ').trim() || '';
}

function tidy(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function countWords(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function estimateTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}

export function normalizeHttpUrl(href, baseUrl) {
  if (!href || /^\s*(javascript:|mailto:|tel:|#)/i.test(href)) return null;
  let parsed;
  try {
    parsed = new URL(href, baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.hash = '';
  return parsed.href;
}

function collectAnchors(document, baseUrl, limit = 100) {
  const links = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = normalizeHttpUrl(anchor.getAttribute('href'), baseUrl);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({
      url: href,
      text: tidy(anchor.textContent || '').replace(/\s+/g, ' '),
    });
    if (links.length >= limit) break;
  }
  return links;
}

function removeMatching(document, selectors) {
  const seen = new Set();
  for (const selector of selectors) {
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    let nodes = [];
    try {
      nodes = [...document.querySelectorAll(selector)];
    } catch {
      continue;
    }
    for (const node of nodes) node.remove();
  }
}

function sameAsTitle(text, title) {
  const left = tidy(text).replace(/\s+/g, ' ').toLowerCase();
  const right = tidy(title).replace(/\s+/g, ' ').toLowerCase();
  return Boolean(right) && left === right;
}

function ensureHeading(markdown, title) {
  const headingText = tidy(title).replace(/\s+/g, ' ');
  if (!headingText) return markdown;
  const heading = `# ${headingText}`;
  const body = String(markdown || '').trim();
  if (!body) return heading;
  if (body === heading || body.startsWith(`${heading}\n`)) return body;
  return `${heading}\n\n${body}`;
}

function htmlToMarkdown(html) {
  if (!html || !String(html).trim()) return '';
  try {
    return tidy(turndown.turndown(html));
  } catch {
    return '';
  }
}

export function isBotChallenge(html, extracted) {
  if ((extracted?.wordCount || 0) >= 120) return false;
  return BOT_CHALLENGE.test(`${extracted?.title || ''}\n${String(html || '').slice(0, 8000)}`);
}

export function isJsShell(html) {
  const source = String(html || '');
  if (JS_SHELL.test(source)) return true;
  const scriptCount = (source.match(/<script\b/gi) || []).length;
  const visible = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (scriptCount >= 2 && visible.length < 200) || (scriptCount >= 1 && visible.length < 80);
}

export function shouldUseBrowserFallback(html, extracted) {
  const words = extracted?.wordCount || 0;
  if (words >= 40) return false;
  if (isBotChallenge(html, extracted)) return false;
  if (words === 0) return true;
  return isJsShell(html);
}

export function discoverLinks(html, pageUrl, limit = 100) {
  const document = parseDocument(html, pageUrl);
  const pageHost = new URL(pageUrl).host;
  return collectAnchors(document, pageUrl, limit).filter((link) => {
    try {
      const parsed = new URL(link.url);
      if (parsed.host !== pageHost) return false;
      return !SKIP_PATH.test(parsed.pathname);
    } catch {
      return false;
    }
  });
}

export function extractPage(html, pageUrl, options = {}) {
  const document = parseDocument(html, pageUrl);
  const title = (
    metaContent(document, 'meta[property="og:title"]')
    || document.querySelector('title')?.textContent
    || document.querySelector('h1')?.textContent
    || ''
  ).replace(/\s+/g, ' ').trim();
  const description = (
    metaContent(document, 'meta[name="description"]')
    || metaContent(document, 'meta[property="og:description"]')
  ).slice(0, 300);

  const selectors = [...DEFAULT_REMOVE_SELECTORS, ...(options.removeSelectors || [])];
  removeMatching(document, selectors);

  let article = null;
  try {
    article = new Readability(document).parse();
  } catch {
    article = null;
  }

  let markdown = '';
  let text = '';
  let contentLinks = [];
  if (article?.content) {
    markdown = htmlToMarkdown(article.content);
    text = tidy(article.textContent || '');
    contentLinks = collectAnchors(parseDocument(`<body>${article.content}</body>`, pageUrl), pageUrl);
  } else if (document.body) {
    markdown = htmlToMarkdown(document.body.innerHTML || '');
    text = tidy(document.body.textContent || '');
    contentLinks = collectAnchors(document, pageUrl);
  }

  const resolvedTitle = tidy(article?.title || title).slice(0, 300);
  const plainSource = text || tidy(markdown.replace(/[#>*_`\[\]()!-]/g, ' '));
  const plain = sameAsTitle(plainSource, resolvedTitle) ? '' : plainSource;
  markdown = plain ? ensureHeading(markdown, resolvedTitle) : '';
  return {
    title: resolvedTitle,
    description: description || tidy(plain).slice(0, 180),
    markdown,
    text: plain,
    links: contentLinks,
    wordCount: countWords(plain),
    tokenEstimate: estimateTokens(plain),
  };
}

export function toDatasetRecord(extracted, options) {
  const outputFormat = options.outputFormat || 'markdown';
  const record = {
    url: options.url,
    title: extracted.title || '',
    description: extracted.description || '',
  };
  if (outputFormat === 'markdown' || outputFormat === 'both') record.markdown = extracted.markdown || '';
  if (outputFormat === 'text' || outputFormat === 'both') record.text = extracted.text || '';
  record.wordCount = extracted.wordCount || 0;
  record.tokenEstimate = extracted.tokenEstimate || 0;
  if (options.includeLinks) record.links = extracted.links || [];
  record.fetchedAt = options.fetchedAt || new Date().toISOString();
  record.status = options.status;
  return record;
}

export function emptyExtraction() {
  return {
    title: '',
    description: '',
    markdown: '',
    text: '',
    links: [],
    wordCount: 0,
    tokenEstimate: 0,
  };
}
