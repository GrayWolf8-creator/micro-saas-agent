// A failed Redis read of the subscriber list must not be treated as empty and then SET back.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.ALERTS_TEST_ALLOW_LOCAL = '1';
process.env.UPSTASH_REDIS_REST_URL = 'https://example.test/redis';
process.env.UPSTASH_REDIS_REST_TOKEN = 'unit-test-token';

const alerts = await import('../alerts.js');
const weekly = await import('../weekly.js');

const OLD = {
  sub_old: {
    id: 'sub_old', secret: 'whsec_old', webhookUrl: 'https://example.com/old', filter: 'outer', pairs: null,
    createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', alertsLeft: 10, payer: null, failures: 0
  }
};
const OLD_WEEK = {
  wk_old: {
    id: 'wk_old', secret: 'whsec_old', webhookUrl: 'https://example.com/old', createdAt: '2026-01-01T00:00:00.000Z',
    plan: '4w', issuesLeft: 4, expiresAt: '2099-01-01T00:00:00.000Z', lastIssue: null, failsThisIssue: 0, missed: []
  }
};

let mode = 'ok';
const sets = [];
globalThis.fetch = async (_url, opts) => {
  const cmd = JSON.parse(opts.body);
  if (mode === 'throw') throw new Error('redis down');
  if (mode === 'http') return { ok: false, status: 503, json: async () => ({}) };
  if (mode === 'body-error') return { ok: true, json: async () => ({ error: 'ERR timeout', result: null }) };
  if (cmd[0] === 'GET') {
    const raw = cmd[1] === 'gw8:weekly_subs'
      ? (mode === 'empty' ? null : mode === 'bad' ? '{' : JSON.stringify(OLD_WEEK))
      : (mode === 'empty' ? null : mode === 'bad' ? '{' : JSON.stringify(OLD));
    return { ok: true, json: async () => ({ result: raw }) };
  }
  if (cmd[0] === 'SET') {
    sets.push([cmd[1], cmd[2]]);
    return { ok: true, json: async () => ({ result: 'OK' }) };
  }
  return { ok: true, json: async () => ({ result: null }) };
};

const hook = { webhookUrl: 'http://127.0.0.1/hook', filter: 'outer', pairs: null };

function reset() {
  sets.length = 0;
  alerts._resetForTest();
  weekly._resetWeeklyForTest();
}

test('failed alerts read does not overwrite the stored subscriber list', async () => {
  for (const fail of ['http', 'throw', 'body-error', 'bad']) {
    reset();
    mode = fail;
    const v = await alerts.validateSubscribe(hook, ['BTC']);
    assert.equal(v.error, 'alerts temporarily unavailable, retry shortly');
    const created = await alerts.createSubscription(hook);
    assert.equal(created.error, 'alerts temporarily unavailable, retry shortly');
    assert.equal(await alerts.cancelSubscription('sub_old'), false);
    alerts._resetForTest();
    const first = await alerts.onRefresh({ bandDots: [{ name: 'BTC', bar: '1', kind: 'green', band: 'outer', wt1: 1, close: 1 }] });
    assert.equal(first.seeded, true);
    const second = await alerts.onRefresh({ bandDots: [{ name: 'ETH', bar: '2', kind: 'green', band: 'outer', wt1: 1, close: 1 }] });
    assert.equal(second.unavailable, true);
    assert.equal(sets.length, 0, fail);
  }

  reset();
  mode = 'ok';
  const created = await alerts.createSubscription(hook);
  assert.ok(created.subscriptionId);
  assert.equal(sets.length, 1);
  assert.equal(sets[0][0], 'gw8:alert_subs');
  const stored = JSON.parse(sets[0][1]);
  assert.equal(stored.sub_old.id, 'sub_old');
  assert.equal(stored[created.subscriptionId].webhookUrl, hook.webhookUrl);
  assert.equal(Object.keys(stored).length, 2);

  reset();
  mode = 'empty';
  const fresh = await alerts.createSubscription(hook);
  assert.ok(fresh.subscriptionId);
  const only = JSON.parse(sets[0][1]);
  assert.deepEqual(Object.keys(only), [fresh.subscriptionId]);

  reset();
  mode = 'http';
  assert.equal((await alerts.createSubscription(hook)).error, 'alerts temporarily unavailable, retry shortly');
  assert.equal(sets.length, 0);
  mode = 'ok';
  const retried = await alerts.createSubscription(hook);
  assert.ok(retried.subscriptionId);
  assert.equal(JSON.parse(sets[0][1]).sub_old.id, 'sub_old');
});

test('failed weekly read does not overwrite the stored subscriber list', async () => {
  for (const fail of ['http', 'bad']) {
    reset();
    mode = fail;
    const v = await weekly.validateWeekly({ webhookUrl: 'http://127.0.0.1/hook' });
    assert.equal(v.error, 'weekly briefs temporarily unavailable, retry shortly');
    const created = await weekly.createWeekly({ webhookUrl: 'http://127.0.0.1/hook' });
    assert.equal(created.error, 'weekly briefs temporarily unavailable, retry shortly');
    assert.equal(await weekly.cancelWeekly('wk_old'), false);
    assert.equal(sets.length, 0, fail);
  }

  reset();
  mode = 'ok';
  const created = await weekly.createWeekly({ webhookUrl: 'http://127.0.0.1/hook' });
  assert.ok(created.subscriptionId);
  const stored = JSON.parse(sets[0][1]);
  assert.equal(sets[0][0], 'gw8:weekly_subs');
  assert.equal(stored.wk_old.id, 'wk_old');
  assert.ok(stored[created.subscriptionId]);
});
