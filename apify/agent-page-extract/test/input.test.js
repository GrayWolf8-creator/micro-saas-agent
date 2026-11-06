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
