import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserBatchBudgetMs, BROWSER_TIME_BUDGET_MS, extractSite, prepareBrowserNavigation } from '../src/crawl.js';
import { normalizeInput } from '../src/input.js';
import { CHARGE_EVENTS, publishPage } from '../src/publish.js';
import { persistRunStats, statusMessageFor } from '../src/telemetry.js';
import { startFixtureServer } from './server.js';

process.env.AGENT_PAGE_EXTRACT_CHROME_PATH = process.env.AGENT_PAGE_EXTRACT_CHROME_PATH || '/usr/local/bin/google-chrome';

function article(href) {
  const sentence = 'The rendered article has enough words for the reader to keep. ';
  const link = href ? `<p><a href="${href}">Next shell</a></p>` : '';
  return `<!doctype html><html><head><title>Rendered</title></head><body><article><h1>Rendered</h1><p>${sentence.repeat(12)}</p>${link}</article></body></html>`;
}

function chargingActor(events) {
  return {
    async charge({ eventName }) {
      events.push(eventName);
      return { chargedCount: 1, eventChargeLimitReached: false };
    },
    async pushData() {},
  };
}

async function withServer(fn) {
  const server = await startFixtureServer();
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

test('maxBrowserPages caps Playwright and leaves the rest uncharged empty', async () => {
  await withServer(async (server) => {
    const seen = [];
    const events = [];
    const startUrls = [1, 2, 3, 4, 5].map((n) => `${server.origin}/js/${n}`);
    const { results, stats } = await extractSite(normalizeInput({
      startUrls,
      maxBrowserPages: 2,
      respectRobotsTxt: false,
    }), {
      maxConcurrency: 1,
      memoryMbytes: 1024,
      async runBrowser(batch, _input, handle) {
        for (const job of batch) {
          seen.push(new URL(job.url).pathname);
          await handle({
            url: job.url,
            requestedUrl: job.url,
            html: article(),
            depth: job.depth,
          });
        }
      },
      onPage: (record) => publishPage(chargingActor(events), record),
    });

    assert.deepEqual(seen, ['/js/1', '/js/2']);
    assert.equal(stats.browserPages, 2);
    assert.equal(stats.cheerioPages, 5);
    const skipped = results.filter((record) => record.note === 'browser budget reached');
    assert.equal(skipped.length, 3);
    assert.ok(skipped.every((record) => record.status === 'empty'));
    assert.equal(results.filter((record) => record.status === 'ok').length, 2);
    assert.deepEqual(events, [CHARGE_EVENTS.page, CHARGE_EVENTS.page]);
  });
});

test('maxBrowserPages 0 stays on Cheerio', async () => {
  await withServer(async (server) => {
    const { results, stats } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/js/1`],
      maxBrowserPages: 0,
      useBrowserFallback: true,
      respectRobotsTxt: false,
    }), {
      memoryMbytes: 2048,
      async runBrowser() {
        throw new Error('Playwright fallback should not have run');
      },
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'empty');
    assert.equal(results[0].note, 'browser budget reached');
    assert.equal(stats.browserPages, 0);
    assert.equal(stats.cheerioPages, 1);
    assert.equal((server.hits.get('/js/1') || 0) >= 1, true);
  });
});

test('browser time budget and low memory skip further Playwright work', async () => {
  await withServer(async (server) => {
    let clock = 0;
    const calls = [];
    const events = [];
    const timed = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/js/1`],
      crawlDepth: 1,
      maxPages: 5,
      maxBrowserPages: 5,
      respectRobotsTxt: false,
    }), {
      maxConcurrency: 1,
      memoryMbytes: 1024,
      now: () => clock,
      async runBrowser(batch, _input, handle) {
        calls.push(batch.map((job) => new URL(job.url).pathname));
        clock += 90_000;
        const job = batch[0];
        await handle({
          url: job.url,
          requestedUrl: job.url,
          html: article('/js/2'),
          depth: job.depth,
        });
      },
      onPage: (record) => publishPage(chargingActor(events), record),
    });

    assert.deepEqual(calls, [['/js/1']]);
    assert.equal(timed.stats.browserPages, 1);
    assert.equal(timed.stats.browserMs, 90_000);
    assert.equal(timed.stats.cheerioPages, 2);
    const delayed = timed.results.find((record) => new URL(record.url).pathname === '/js/2');
    assert.equal(delayed.status, 'empty');
    assert.equal(delayed.note, 'browser time budget reached');
    assert.deepEqual(events, [CHARGE_EVENTS.page]);

    const lowEvents = [];
    const low = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/js/3`],
      maxBrowserPages: 3,
      respectRobotsTxt: false,
    }), {
      memoryMbytes: 512,
      async runBrowser() {
        throw new Error('Playwright fallback should not have run');
      },
      onPage: (record) => publishPage(chargingActor(lowEvents), record),
    });
    assert.equal(low.results[0].status, 'empty');
    assert.equal(low.results[0].note, 'memory below 1024MB');
    assert.equal(low.stats.browserPages, 0);
    assert.equal(low.stats.memoryMbytes, 512);
    assert.deepEqual(lowEvents, []);
    const stored = [];
    const record = await persistRunStats({
      async setValue(key, value) {
        stored.push([key, value]);
      },
    }, low.stats);
    assert.deepEqual(stored, [['RUN_STATS', record]]);
    assert.deepEqual(record, {
      cheerioPages: 1,
      browserPages: 0,
      browserMs: 0,
      memoryMbytes: 512,
    });
    assert.match(statusMessageFor(low.results, low.stats), /browser pages 0/);
  });
});

test('1024MB still allows Playwright and a null memory reading does not block it', async () => {
  await withServer(async (server) => {
    for (const memoryMbytes of [1024, null]) {
      let opened = 0;
      const { stats } = await extractSite(normalizeInput({
        startUrls: [`${server.origin}/app`],
        respectRobotsTxt: false,
      }), {
        memoryMbytes,
        async runBrowser(batch, _input, handle) {
          opened += batch.length;
          const job = batch[0];
          await handle({
            url: job.url,
            requestedUrl: job.url,
            html: article(),
            depth: job.depth,
          });
        },
      });
      assert.equal(opened, 1);
      assert.equal(stats.browserPages, 1);
      assert.equal(stats.memoryMbytes, memoryMbytes === null ? null : 1024);
    }
  });
});

test('the 90s browser budget carries across depth batches', async () => {
  await withServer(async (server) => {
    let clock = 0;
    const budgets = [];
    const calls = [];
    const { results, stats } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/js/1`],
      crawlDepth: 2,
      maxPages: 10,
      maxBrowserPages: 10,
      respectRobotsTxt: false,
    }), {
      maxConcurrency: 1,
      memoryMbytes: 1024,
      now: () => clock,
      async runBrowser(batch, _input, handle, runOptions) {
        budgets.push(runOptions.browserBudgetMs);
        calls.push(batch.map((job) => new URL(job.url).pathname));
        clock += 60_000;
        const job = batch[0];
        const next = job.url.endsWith('/1') ? '/js/2' : '/js/3';
        await handle({
          url: job.url,
          requestedUrl: job.url,
          html: article(next),
          depth: job.depth,
        });
      },
    });

    assert.equal(browserBatchBudgetMs(0), BROWSER_TIME_BUDGET_MS);
    assert.equal(browserBatchBudgetMs(60_000), 30_000);
    assert.equal(browserBatchBudgetMs(90_000), 0);
    assert.equal(browserBatchBudgetMs(0, 0), 0);
    assert.equal(browserBatchBudgetMs(60_000, 120_000), 30_000);
    assert.deepEqual(budgets, [BROWSER_TIME_BUDGET_MS, 30_000]);
    assert.deepEqual(calls, [['/js/1'], ['/js/2']]);
    const third = results.find((record) => new URL(record.url).pathname === '/js/3');
    assert.equal(third.status, 'empty');
    assert.equal(third.note, 'browser time budget reached');
    assert.equal(stats.browserPages, 2);
    assert.equal(stats.browserMs, 120_000);
  });
});

test('pages left after the charge limit are not labeled as a time-budget skip', async () => {
  await withServer(async (server) => {
    const events = [];
    const { results } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/js/1`, `${server.origin}/js/2`],
      maxBrowserPages: 5,
      respectRobotsTxt: false,
    }), {
      maxConcurrency: 1,
      memoryMbytes: 1024,
      async runBrowser(batch, _input, handle) {
        const first = batch[0];
        await handle({
          url: first.url,
          requestedUrl: first.url,
          html: article(),
          depth: first.depth,
        });
        const rest = batch[1];
        await handle({
          url: rest.url,
          requestedUrl: rest.url,
          html: '',
          skippedBudget: true,
          depth: rest.depth,
        });
      },
      onPage(record) {
        if (record.status !== 'ok') return { stop: false, pushed: true };
        events.push(record.status);
        return { stop: true, pushed: true };
      },
    });
    const kept = results.find((record) => new URL(record.url).pathname === '/js/1');
    const dropped = results.find((record) => new URL(record.url).pathname === '/js/2');
    assert.equal(kept.status, 'ok');
    assert.equal(dropped.status, 'empty');
    assert.equal(dropped.note, 'charge limit reached');
    assert.deepEqual(events, ['ok']);
  });
});

test('a browser batch stops scheduling once its wall clock is spent', { timeout: 60_000 }, async () => {
  await withServer(async (server) => {
    const events = [];
    const { results, stats } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/js/1`, `${server.origin}/js/2`],
      maxBrowserPages: 5,
      respectRobotsTxt: false,
    }), {
      maxConcurrency: 1,
      memoryMbytes: 1024,
      pageBrowserBudgetMs: 0,
      onPage: (record) => publishPage(chargingActor(events), record),
    });
    const first = results.find((record) => new URL(record.url).pathname === '/js/1');
    const second = results.find((record) => new URL(record.url).pathname === '/js/2');
    assert.equal(first.status, 'ok');
    assert.match(first.markdown, /RENDERED-PHRASE/);
    assert.equal(second.status, 'empty');
    assert.equal(second.note, 'browser time budget reached');
    assert.equal(stats.browserPages, 1);
    assert.equal(server.hits.get('/js/2'), 1);
    assert.deepEqual(events, [CHARGE_EVENTS.page]);
  });
});

test('Playwright navigation waits for domcontentloaded and blocks images, fonts, and media', async () => {
  const gotoOptions = {};
  const routes = [];
  await prepareBrowserNavigation({
    page: {
      async route(pattern, handler) {
        routes.push({ pattern, handler });
      },
    },
  }, gotoOptions);
  assert.equal(gotoOptions.waitUntil, 'domcontentloaded');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].pattern, '**/*');

  const decisions = [];
  const fakeRoute = (type) => ({
    request: () => ({ resourceType: () => type }),
    abort: () => { decisions.push(`abort:${type}`); },
    continue: () => { decisions.push(`continue:${type}`); },
  });
  for (const type of ['image', 'font', 'media', 'document', 'script', 'stylesheet']) {
    await routes[0].handler(fakeRoute(type));
  }
  assert.deepEqual(decisions, [
    'abort:image',
    'abort:font',
    'abort:media',
    'continue:document',
    'continue:script',
    'continue:stylesheet',
  ]);

  const closed = (type) => ({
    request: () => ({ resourceType: () => type }),
    abort: () => Promise.reject(new Error('page closed')),
    continue: () => { throw new Error('page closed'); },
  });
  await assert.doesNotReject(() => routes[0].handler(closed('image')));
  await assert.doesNotReject(() => routes[0].handler(closed('document')));
});
