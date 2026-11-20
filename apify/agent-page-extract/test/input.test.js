import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeInput } from '../src/input.js';

test('applies product defaults and caps', () => {
  const input = normalizeInput({ startUrls: ['https://example.com/docs'] });
  assert.deepEqual(input.startUrls, ['https://example.com/docs']);
  assert.equal(input.crawlDepth, 0);
  assert.equal(input.maxPages, 10);
  assert.equal(input.includeLinks, false);
  assert.equal(input.outputFormat, 'markdown');
  assert.equal(input.useBrowserFallback, true);
  assert.equal(input.maxBrowserPages, 3);
  assert.equal(input.respectRobotsTxt, true);
  assert.deepEqual(input.removeSelectors, []);
});

test('clamps depth and page count and keeps explicit flags', () => {
  const input = normalizeInput({
    startUrls: [{ url: 'https://example.com/a' }, { url: 'https://example.com/a#section' }, 'https://example.com/b'],
    crawlDepth: 9,
    maxPages: 500,
    includeLinks: true,
    outputFormat: 'both',
    removeSelectors: [' .promo ', ''],
    useBrowserFallback: false,
    respectRobotsTxt: false,
  });
  assert.deepEqual(input.startUrls, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(input.crawlDepth, 2);
  assert.equal(input.maxPages, 200);
  assert.equal(input.includeLinks, true);
  assert.equal(input.outputFormat, 'both');
  assert.deepEqual(input.removeSelectors, ['.promo']);
  assert.equal(input.useBrowserFallback, false);
  assert.equal(input.respectRobotsTxt, false);
});

test('rejects an empty or non-http start list', () => {
  assert.throws(() => normalizeInput({ startUrls: [] }), /startUrls/);
  assert.throws(() => normalizeInput({ startUrls: ['ftp://example.com/file'] }), /http/);
  assert.throws(() => normalizeInput({ startUrls: ['not a url'] }), /invalid URL/);
});

test('raises a zero or negative page cap to one and a negative depth to zero', () => {
  const input = normalizeInput({ startUrls: ['https://example.com'], maxPages: 0, crawlDepth: -3, outputFormat: 'nope' });
  assert.equal(input.maxPages, 1);
  assert.equal(input.crawlDepth, 0);
  assert.equal(input.outputFormat, 'markdown');
});

test('clamps maxBrowserPages to 0..20 and keeps zero as Cheerio-only', () => {
  const high = normalizeInput({ startUrls: ['https://example.com'], maxBrowserPages: 21.9 });
  const low = normalizeInput({ startUrls: ['https://example.com'], maxBrowserPages: -4 });
  const zero = normalizeInput({ startUrls: ['https://example.com'], maxBrowserPages: 0 });
  const exact = normalizeInput({ startUrls: ['https://example.com'], maxBrowserPages: 2 });
  assert.equal(high.maxBrowserPages, 20);
  assert.equal(low.maxBrowserPages, 0);
  assert.equal(zero.maxBrowserPages, 0);
  assert.equal(exact.maxBrowserPages, 2);
});
