import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRobots, parseRobots, robotsAllow, USER_AGENT } from '../src/robots.js';

test('blocks the disallowed path and allows the rest', () => {
  const groups = parseRobots('User-agent: *\nDisallow: /secret\n');
  assert.equal(robotsAllow(groups, 'https://example.com/secret'), false);
  assert.equal(robotsAllow(groups, 'https://example.com/secret/page'), false);
  assert.equal(robotsAllow(groups, 'https://example.com/docs'), true);
});

test('lets the longer allow rule win', () => {
  const groups = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/public\n');
  assert.equal(robotsAllow(groups, 'https://example.com/private/hidden'), false);
  assert.equal(robotsAllow(groups, 'https://example.com/private/public/page'), true);
});

test('uses the matching agent group instead of the star group', () => {
  const groups = parseRobots([
    'User-agent: *',
    'Disallow: /docs',
    '',
    'User-agent: AgentPageExtract',
    'Disallow: /secret',
    'Allow: /',
  ].join('\n'));
  assert.equal(robotsAllow(groups, 'https://example.com/docs', USER_AGENT), true);
  assert.equal(robotsAllow(groups, 'https://example.com/secret', USER_AGENT), false);
});

test('treats a missing robots file as allow', async () => {
  const groups = await loadRobots('https://example.com', async () => ({ ok: false, text: async () => '' }));
  assert.deepEqual(groups, []);
  assert.equal(robotsAllow(groups, 'https://example.com/docs'), true);
});
