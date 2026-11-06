import { CheerioCrawler, Configuration, PlaywrightCrawler, RequestQueue } from 'crawlee';
import {
  discoverLinks,
  emptyExtraction,
  extractPage,
  isBotChallenge,
  shouldUseBrowserFallback,
  toDatasetRecord,
} from './extract.js';
import { loadRobots, robotsAllow, USER_AGENT } from './robots.js';

let queueSeq = 0;

function memoryConfig() {
  return new Configuration({ persistStorage: false, purgeOnStart: true });
}

function nextQueueName(prefix) {
  queueSeq += 1;
  return `${prefix}-${queueSeq}-${Date.now()}`;
}

function browserLaunchContext() {
  const launchOptions = {
    headless: true,
    args: ['--disable-dev-shm-usage'],
  };
  const executablePath = process.env.AGENT_PAGE_EXTRACT_CHROME_PATH;
  if (executablePath) {
    launchOptions.executablePath = executablePath;
    launchOptions.args.push('--no-sandbox', '--disable-gpu');
  }
  return { userAgent: USER_AGENT, launchOptions };
}

function coerceHtml($, body) {
  if (typeof body === 'string' && body.includes('<')) return body;
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8');
    if (text.includes('<')) return text;
  }
  try {
    return $.html();
  } catch {
    return '';
  }
}

function childLinks(html, pageUrl, depth, input) {
  if (depth >= input.crawlDepth) return [];
  return discoverLinks(html, pageUrl).map((link) => ({ url: link.url, depth: depth + 1 }));
}

function recordFrom(url, extracted, status, input) {
  return toDatasetRecord(extracted, {
    url,
    status,
    outputFormat: input.outputFormat,
    includeLinks: input.includeLinks,
    fetchedAt: new Date().toISOString(),
  });
}

async function runCheerio(batch, input, handle, options) {
  const config = memoryConfig();
  const requestQueue = await RequestQueue.open(nextQueueName('cheerio'), { config });
  let crawler;
  crawler = new CheerioCrawler({
    requestQueue,
    maxRequestsPerCrawl: batch.length,
    maxConcurrency: options.maxConcurrency ?? 5,
    minConcurrency: 1,
    maxRequestRetries: options.maxRequestRetries ?? 1,
    requestHandlerTimeoutSecs: 30,
    navigationTimeoutSecs: 20,
    useSessionPool: false,
    persistCookiesPerSession: false,
    retryOnBlocked: false,
    respectRobotsTxtFile: input.respectRobotsTxt ? { userAgent: USER_AGENT } : false,
    preNavigationHooks: [
      (_ctx, gotOptions) => {
        if (!gotOptions) return;
        gotOptions.headers = {
          ...(gotOptions.headers || {}),
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        };
      },
    ],
    async requestHandler({ request, $, body, response }) {
      const statusCode = response?.statusCode ?? 0;
      if (statusCode >= 400) {
        await handle({
          url: request.loadedUrl || request.url,
          requestedUrl: request.url,
          html: '',
          error: `HTTP ${statusCode}`,
          depth: request.userData?.depth || 0,
        });
        return;
      }
      await handle({
        url: request.loadedUrl || request.url,
        requestedUrl: request.url,
        html: coerceHtml($, body),
        depth: request.userData?.depth || 0,
      });
    },
    async failedRequestHandler({ request }) {
      await handle({
        url: request.url,
        requestedUrl: request.url,
        html: '',
        error: 'fetch failed',
        depth: request.userData?.depth || 0,
      });
    },
    async onSkippedRequest({ url, reason }) {
      if (reason !== 'robotsTxt') return;
      await handle({
        url,
        requestedUrl: url,
        html: '',
        skippedRobots: true,
        depth: 0,
      });
    },
  }, config);
  options.bindCrawler?.(crawler);
  await crawler.run(batch.map((item) => ({
    url: item.url,
    uniqueKey: item.url,
    userData: { depth: item.depth },
  })));
}

async function runPlaywright(batch, input, handle) {
  const config = memoryConfig();
  const requestQueue = await RequestQueue.open(nextQueueName('browser'), { config });
  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxRequestsPerCrawl: batch.length,
    maxConcurrency: 1,
    maxRequestRetries: 0,
    requestHandlerTimeoutSecs: 45,
    navigationTimeoutSecs: 25,
    useSessionPool: false,
    persistCookiesPerSession: false,
    retryOnBlocked: false,
    respectRobotsTxtFile: input.respectRobotsTxt ? { userAgent: USER_AGENT } : false,
    launchContext: browserLaunchContext(),
    async requestHandler({ request, page, response }) {
      const statusCode = typeof response?.status === 'function' ? response.status() : 0;
      if (statusCode >= 400) {
        await handle({
          url: request.loadedUrl || request.url,
          requestedUrl: request.url,
          html: '',
          error: `HTTP ${statusCode}`,
          depth: request.userData?.depth || 0,
        });
        return;
      }
      await page.waitForFunction(
        () => (document.body?.innerText || '').trim().length > 40,
        { timeout: 1500 },
      ).catch(() => {});
      const current = page.url();
      const finalUrl = current && current.startsWith('http') ? current : (request.loadedUrl || request.url);
      await handle({
        url: finalUrl,
        requestedUrl: request.url,
        html: await page.content(),
        depth: request.userData?.depth || 0,
      });
    },
    async failedRequestHandler({ request }) {
      await handle({
        url: request.url,
        requestedUrl: request.url,
        html: '',
        error: 'browser fetch failed',
        depth: request.userData?.depth || 0,
      });
    },
  }, config);
  await crawler.run(batch.map((item) => ({
    url: item.url,
    uniqueKey: item.url,
    userData: { depth: item.depth },
  })));
}

export async function extractSite(input, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const onPage = options.onPage || (async () => {});
  const robotsCache = new Map();
  const visited = new Set();
  const finished = new Set();
  const results = [];
  let stop = false;
  let processed = 0;
  let activeCrawler = null;
  let frontier = input.startUrls.map((url) => ({ url, depth: 0 }));

  async function remember(record) {
    if (finished.has(record.url)) return { stop, pushed: false };
    finished.add(record.url);
    results.push(record);
    processed += 1;
    const published = await onPage(record);
    if (published?.stop) {
      stop = true;
      try { activeCrawler?.stop('charge limit reached'); } catch { /* already stopping */ }
    }
    return published;
  }

  async function allowed(url) {
    if (!input.respectRobotsTxt) return true;
    const origin = new URL(url).origin;
    if (!robotsCache.has(origin)) {
      robotsCache.set(origin, await loadRobots(origin, fetchImpl, USER_AGENT));
    }
    return robotsAllow(robotsCache.get(origin), url, USER_AGENT);
  }

  async function acceptPage(page, discover) {
    if (stop) return;
    if (page.skippedRobots) {
      await remember(recordFrom(page.url, emptyExtraction(), 'blocked', input));
      return;
    }
    if (page.error || !page.html) {
      await remember(recordFrom(page.url, emptyExtraction(), 'error', input));
      return;
    }
    const finalUrl = page.url;
    if (finalUrl !== page.requestedUrl) visited.add(finalUrl);
    let extracted;
    try {
      extracted = extractPage(page.html, finalUrl, input);
    } catch {
      await remember(recordFrom(finalUrl, emptyExtraction(), 'error', input));
      return;
    }
    if (isBotChallenge(page.html, extracted)) {
      await remember(recordFrom(finalUrl, extracted, 'blocked', input));
      return;
    }
    const status = extracted.wordCount > 0 ? 'ok' : 'empty';
    await remember(recordFrom(finalUrl, extracted, status, input));
    if (status === 'ok') discover.push(...childLinks(page.html, finalUrl, page.depth, input));
  }

  while (frontier.length && processed < input.maxPages && !stop) {
    const batch = [];
    for (const item of frontier) {
      if (stop || processed + batch.length >= input.maxPages) break;
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      if (!(await allowed(item.url))) {
        await remember(recordFrom(item.url, emptyExtraction(), 'blocked', input));
        continue;
      }
      batch.push(item);
    }

    const discovered = [];
    const browserJobs = [];
    if (batch.length && !stop) {
      await runCheerio(batch, input, async (page) => {
        if (stop) return;
        if (!page.error && !page.skippedRobots && page.html) {
          let extracted;
          try {
            extracted = extractPage(page.html, page.url, input);
          } catch {
            extracted = null;
          }
          if (extracted && !isBotChallenge(page.html, extracted) && input.useBrowserFallback && shouldUseBrowserFallback(page.html, extracted)) {
            browserJobs.push({ url: page.url, depth: page.depth });
            if (page.url !== page.requestedUrl) visited.add(page.url);
            return;
          }
        }
        await acceptPage(page, discovered);
      }, {
        ...options,
        bindCrawler(crawler) { activeCrawler = crawler; },
      });
    }

    if (browserJobs.length && !stop && processed < input.maxPages) {
      const jobs = browserJobs.slice(0, input.maxPages - processed);
      const runBrowser = options.runBrowser || runPlaywright;
      activeCrawler = null;
      await runBrowser(jobs, input, async (page) => {
        await acceptPage(page, discovered);
      });
    }

    const next = [];
    const queued = new Set();
    for (const link of discovered) {
      if (link.depth > input.crawlDepth || visited.has(link.url) || queued.has(link.url)) continue;
      queued.add(link.url);
      next.push(link);
    }
    frontier = next;
  }

  return { results };
}
