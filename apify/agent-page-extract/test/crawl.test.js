import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CRAWLEE_LOG_LEVEL = 'ERROR';
process.env.CRAWLEE_PERSIST_STORAGE = '0';
process.env.AGENT_PAGE_EXTRACT_CHROME_PATH = '/usr/local/bin/google-chrome';

const { extractSite } = await import('../src/crawl.js');
const { normalizeInput } = await import('../src/input.js');
const { startFixtureServer } = await import('./server.js');

function noBrowser() {
  return {
    maxRequestRetries: 0,
    async runBrowser() {
      throw new Error('Playwright fallback should not have run');
    },
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

function byUrl(results) {
  return new Map(results.map((record) => [new URL(record.url).pathname, record]));
}

test('crawls the local article and strips chrome from the dataset row', async () => {
  await withServer(async (server) => {
    const { results } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/docs`],
      includeLinks: true,
      outputFormat: 'both',
    }), noBrowser());
    assert.equal(results.length, 1);
    const row = results[0];
    assert.equal(row.status, 'ok');
    assert.match(row.title, /Getting started/);
    assert.match(row.markdown, /ALPHA-PHRASE-ARTICLE/);
    assert.match(row.text, /ALPHA-PHRASE-ARTICLE/);
    assert.equal(row.markdown.includes('COOKIE-BANNER-PHRASE'), false);
    assert.equal(row.markdown.includes('AD-SLOT-PHRASE'), false);
    assert.equal(row.markdown.includes('FOOTER-PHRASE'), false);
    assert.equal(row.markdown.includes('NAV-PHRASE'), false);
    assert.ok(row.wordCount > 20);
    assert.equal(row.tokenEstimate, Math.ceil(row.text.length / 4));
    assert.ok(row.links.some((link) => link.url === `${server.origin}/docs/next`));
    assert.equal(Number.isNaN(Date.parse(row.fetchedAt)), false);
    assert.equal(server.hits.get('/docs/next') || 0, 0);
  });
});

test('depth 1 follows one hop and depth 2 follows two', async () => {
  await withServer(async (server) => {
    const depthOne = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/docs`],
      crawlDepth: 1,
      maxPages: 10,
    }), noBrowser());
    const paths = [...byUrl(depthOne.results).keys()].sort();
    assert.deepEqual(paths, ['/docs', '/docs/next']);
    assert.equal(server.hits.get('/docs/deep') || 0, 0);

    const depthTwo = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/docs`],
      crawlDepth: 2,
      maxPages: 10,
    }), noBrowser());
    assert.equal(byUrl(depthTwo.results).has('/docs/deep'), true);
    assert.equal(byUrl(depthTwo.results).get('/docs/deep').status, 'ok');
  });
});

test('maxPages stops the crawl', async () => {
  await withServer(async (server) => {
    const { results } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/docs`],
      crawlDepth: 2,
      maxPages: 1,
    }), noBrowser());
    assert.equal(results.length, 1);
    assert.equal(new URL(results[0].url).pathname, '/docs');
  });
});

test('robots.txt blocks /secret without fetching it', async () => {
  await withServer(async (server) => {
    const { results } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/docs`, `${server.origin}/secret`],
      respectRobotsTxt: true,
    }), noBrowser());
    const rows = byUrl(results);
    assert.equal(rows.get('/docs').status, 'ok');
    assert.equal(rows.get('/secret').status, 'blocked');
    assert.equal(server.hits.get('/secret') || 0, 0);
    assert.ok((server.hits.get('/robots.txt') || 0) >= 1);
  });
});

test('respectRobotsTxt false fetches the disallowed page', async () => {
  await withServer(async (server) => {
    const { results } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/secret`],
      respectRobotsTxt: false,
    }), noBrowser());
    assert.equal(results[0].status, 'ok');
    assert.match(results[0].markdown, /SECRET-PHRASE/);
    assert.ok((server.hits.get('/secret') || 0) >= 1);
  });
});

test('a failed fetch is an error row and a short static page does not open a browser', async () => {
  await withServer(async (server) => {
    const missing = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/missing`],
    }), noBrowser());
    assert.equal(missing.results[0].status, 'error');

    const short = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/short`],
      useBrowserFallback: true,
    }), noBrowser());
    assert.equal(short.results[0].status, 'ok');
    assert.match(short.results[0].markdown, /SHORT-PHRASE/);
  });
});

test('a bot check is blocked and is not sent to the browser', async () => {
  await withServer(async (server) => {
    const { results } = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/challenge`],
      useBrowserFallback: true,
    }), noBrowser());
    assert.equal(results[0].status, 'blocked');
  });
});

test('browser fallback renders a JavaScript shell and can be turned off', { timeout: 60_000 }, async () => {
  await withServer(async (server) => {
    const off = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/app`],
      useBrowserFallback: false,
    }), noBrowser());
    assert.equal(off.results[0].status, 'empty');
    assert.equal((off.results[0].markdown || '').includes('RENDERED-PHRASE'), false);

    const on = await extractSite(normalizeInput({
      startUrls: [`${server.origin}/app`],
      useBrowserFallback: true,
    }), { maxRequestRetries: 0 });
    assert.equal(on.results.length, 1);
    assert.equal(on.results[0].status, 'ok');
    assert.match(on.results[0].markdown, /RENDERED-PHRASE/);
    assert.match(on.results[0].markdown, /Rendered dashboard/);
  });
});
