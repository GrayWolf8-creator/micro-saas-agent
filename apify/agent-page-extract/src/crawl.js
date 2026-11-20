import { CheerioCrawler, Configuration, PlaywrightCrawler, RequestQueue, playwrightUtils } from 'crawlee';
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

export const BROWSER_TIME_BUDGET_MS = 90_000;
const LOW_MEMORY_MBYTES = 1024;

// Crawlee 3.18 blockRequests already blocks .css .jpg .jpeg .png .svg .gif .woff .pdf .zip.
// These extras cover the other images, fonts, and media that default list misses.
export const EXTRA_BLOCKED_ASSETS = [
  '.webp', '.avif', '.ico', '.bmp',
  '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mp3', '.ogg', '.wav', '.m4a', '.m4v',
];

export function partitionBrowserJobs(jobs, state) {
  const run = [];
  const skipped = [];
  const lowMemory = typeof state.memoryMbytes === 'number'
    && Number.isFinite(state.memoryMbytes)
    && state.memoryMbytes < LOW_MEMORY_MBYTES;
  const maxBrowserPages = state.maxBrowserPages;
  const budgetMs = Number.isFinite(state.browserBudgetMs) ? state.browserBudgetMs : BROWSER_TIME_BUDGET_MS;
  let reserved = state.browserPages || 0;
  const spent = state.browserMs || 0;
  for (const job of jobs) {
    if (lowMemory) {
      skipped.push({ job, note: 'memory below 1024MB' });
      continue;
    }
    if (reserved >= maxBrowserPages) {
      skipped.push({ job, note: 'browser budget reached' });
      continue;
    }
    if (spent >= budgetMs) {
      skipped.push({ job, note: 'browser time budget reached' });
      continue;
    }
    run.push(job);
    reserved += 1;
  }
  return { run, skipped };
}

export async function prepareBrowserNavigation(context, gotoOptions) {
  if (gotoOptions) gotoOptions.waitUntil = 'domcontentloaded';
  const blockOptions = { extraUrlPatterns: EXTRA_BLOCKED_ASSETS };
  if (typeof context?.blockRequests === 'function') {
    await context.blockRequests(blockOptions);
    return;
  }
  if (context?.page && typeof playwrightUtils?.blockRequests === 'function') {
    await playwrightUtils.blockRequests(context.page, blockOptions);
  }
}

async function containerMemoryMbytes(options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'memoryMbytes')) {
    const value = options.memoryMbytes;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  try {
    const { Actor } = await import('apify');
    const value = Actor.getEnv()?.memoryMbytes;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

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

function recordFrom(url, extracted, status, input, note) {
  return toDatasetRecord(extracted, {
    url,
    status,
    outputFormat: input.outputFormat,
    includeLinks: input.includeLinks,
    fetchedAt: new Date().toISOString(),
    note,
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

async function runPlaywright(batch, input, handle, options = {}) {
  const config = memoryConfig();
  const requestQueue = await RequestQueue.open(nextQueueName('browser'), { config });
  const handled = new Set();
  const budgetMs = Number.isFinite(options.browserBudgetMs) ? options.browserBudgetMs : BROWSER_TIME_BUDGET_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const started = now();
  let crawler;
  const markHandled = (request) => {
    handled.add(request.uniqueKey || request.url);
    handled.add(request.url);
  };
  const stopIfOverBudget = async () => {
    if (now() - started < budgetMs) return;
    try { await crawler?.stop('browser time budget reached'); } catch { /* already stopping */ }
  };
  crawler = new PlaywrightCrawler({
    requestQueue,
    maxRequestsPerCrawl: batch.length,
    maxConcurrency: 1,
    maxRequestRetries: 0,
    requestHandlerTimeoutSecs: 20,
    navigationTimeoutSecs: 15,
    preNavigationHooks: [
      async (context, gotoOptions) => {
        await prepareBrowserNavigation(context, gotoOptions);
      },
    ],
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
        markHandled(request);
        await stopIfOverBudget();
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
      markHandled(request);
      await stopIfOverBudget();
    },
    async failedRequestHandler({ request }) {
      const key = request.uniqueKey || request.url;
      if (handled.has(key) || handled.has(request.url)) return;
      markHandled(request);
      await handle({
        url: request.url,
        requestedUrl: request.url,
        html: '',
        error: 'browser fetch failed',
        depth: request.userData?.depth || 0,
      });
    },
  }, config);
  options.bindCrawler?.(crawler);
  await crawler.run(batch.map((item) => ({
    url: item.url,
    uniqueKey: item.url,
    userData: { depth: item.depth },
  })));
  for (const item of batch) {
    if (handled.has(item.url)) continue;
    await handle({
      url: item.url,
      requestedUrl: item.url,
      html: '',
      skippedBudget: true,
      depth: item.depth || 0,
    });
  }
}

export async function extractSite(input, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const onPage = options.onPage || (async () => {});
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const memoryMbytes = await containerMemoryMbytes(options);
  const robotsCache = new Map();
  const visited = new Set();
  const finished = new Set();
  const results = [];
  let stop = false;
  let processed = 0;
  let cheerioPages = 0;
  let browserPages = 0;
  let browserMs = 0;
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
        cheerioPages += 1;
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
      const { run, skipped } = partitionBrowserJobs(jobs, {
        memoryMbytes,
        maxBrowserPages: input.maxBrowserPages,
        browserPages,
        browserMs,
        browserBudgetMs: options.browserBudgetMs,
      });
      for (const item of skipped) {
        if (stop) break;
        await remember(recordFrom(item.job.url, emptyExtraction(), 'empty', input, item.note));
      }
      if (run.length && !stop) {
        const runBrowser = options.runBrowser || ((batchToRun, siteInput, pageHandle) => runPlaywright(batchToRun, siteInput, pageHandle, {
          bindCrawler(crawler) { activeCrawler = crawler; },
          browserBudgetMs: options.pageBrowserBudgetMs,
          now: options.now,
        }));
        activeCrawler = null;
        const started = now();
        await runBrowser(run, input, async (page) => {
          if (page.skippedBudget) {
            await remember(recordFrom(page.requestedUrl || page.url, emptyExtraction(), 'empty', input, 'browser time budget reached'));
            return;
          }
          browserPages += 1;
          await acceptPage(page, discovered);
        });
        browserMs += Math.max(0, now() - started);
      }
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

  return {
    results,
    stats: {
      cheerioPages,
      browserPages,
      browserMs,
      memoryMbytes: typeof memoryMbytes === 'number' ? memoryMbytes : null,
    },
  };
}
