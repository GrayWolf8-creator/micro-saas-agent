import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  countWords,
  estimateTokens,
  extractPage,
  isBotChallenge,
  shouldUseBrowserFallback,
  toDatasetRecord,
} from '../src/extract.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const pageUrl = 'https://docs.example.com/guide';

async function articleHtml() {
  return readFile(path.join(fixtures, 'article.html'), 'utf8');
}

test('extracts the article and drops nav, footer, ads, and the cookie banner', async () => {
  const html = await articleHtml();
  const page = extractPage(html, pageUrl, { removeSelectors: ['.promo'] });
  assert.match(page.title, /Getting started/);
  assert.match(page.description, /clean markdown/);
  assert.match(page.markdown, /ALPHA-PHRASE-ARTICLE/);
  assert.match(page.markdown, /^# Getting started/m);
  assert.equal(page.markdown.includes('COOKIE-BANNER-PHRASE'), false);
  assert.equal(page.markdown.includes('AD-SLOT-PHRASE'), false);
  assert.equal(page.markdown.includes('FOOTER-PHRASE'), false);
  assert.equal(page.markdown.includes('NAV-PHRASE'), false);
  assert.equal(page.markdown.includes('PROMO-PHRASE'), false);
  assert.ok(page.wordCount > 40);
  assert.equal(page.tokenEstimate, estimateTokens(page.text));
  assert.equal(page.tokenEstimate, Math.ceil(page.text.length / 4));
  const install = page.links.find((link) => link.url === 'https://docs.example.com/guide/install');
  assert.equal(install?.text, 'Install the reader');
});

test('keeps a custom block until removeSelectors names it', async () => {
  const html = await articleHtml();
  const kept = extractPage(html, pageUrl);
  assert.match(kept.markdown, /PROMO-PHRASE/);
});

test('shapes the dataset row from the output format', async () => {
  const html = await articleHtml();
  const page = extractPage(html, pageUrl);
  const markdown = toDatasetRecord(page, {
    url: pageUrl,
    status: 'ok',
    outputFormat: 'markdown',
    includeLinks: false,
    fetchedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.equal(markdown.markdown.includes('ALPHA-PHRASE-ARTICLE'), true);
  assert.equal(Object.hasOwn(markdown, 'text'), false);
  assert.equal(Object.hasOwn(markdown, 'links'), false);
  assert.equal(markdown.status, 'ok');
  assert.equal(markdown.fetchedAt, '2026-11-05T00:00:00.000Z');

  const both = toDatasetRecord(page, {
    url: pageUrl,
    status: 'ok',
    outputFormat: 'both',
    includeLinks: true,
    fetchedAt: '2026-11-05T00:00:00.000Z',
  });
  assert.match(both.text, /ALPHA-PHRASE-ARTICLE/);
  assert.ok(both.links.some((link) => link.url === 'https://example.com/elsewhere'));

  const textOnly = toDatasetRecord(page, {
    url: pageUrl,
    status: 'ok',
    outputFormat: 'text',
    includeLinks: false,
  });
  assert.equal(Object.hasOwn(textOnly, 'markdown'), false);
  assert.match(textOnly.text, /ALPHA-PHRASE-ARTICLE/);
});

test('uses the browser only for empty or JavaScript shells', async () => {
  const article = extractPage(await articleHtml(), pageUrl);
  assert.equal(shouldUseBrowserFallback(await articleHtml(), article), false);

  const shell = await readFile(path.join(fixtures, 'shell.html'), 'utf8');
  const empty = extractPage(shell, 'https://docs.example.com/app');
  assert.equal(empty.wordCount, 0);
  assert.equal(shouldUseBrowserFallback(shell, empty), true);

  const challenge = await readFile(path.join(fixtures, 'challenge.html'), 'utf8');
  const challengePage = extractPage(challenge, 'https://docs.example.com/challenge');
  assert.equal(isBotChallenge(challenge, challengePage), true);
  assert.equal(shouldUseBrowserFallback(challenge, challengePage), false);
});

test('counts words and estimates tokens', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('one two  three'), 3);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});
