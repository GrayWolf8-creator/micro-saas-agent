import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHARGE_EVENTS, publishPage } from '../src/publish.js';

test('charges one page-extracted event for a successful page and still stores failures', async () => {
  const events = [];
  const pushed = [];
  const actor = {
    async charge({ eventName }) {
      events.push(eventName);
      return { chargedCount: 1, eventChargeLimitReached: false };
    },
    async pushData(record) {
      pushed.push(record);
    },
  };
  await publishPage(actor, { status: 'empty', url: 'https://example.com/empty' });
  await publishPage(actor, { status: 'blocked', url: 'https://example.com/secret' });
  const result = await publishPage(actor, { status: 'ok', url: 'https://example.com/docs' });
  assert.deepEqual(events, [CHARGE_EVENTS.page]);
  assert.equal(CHARGE_EVENTS.page, 'page-extracted');
  assert.equal(CHARGE_EVENTS.start, 'actor-start');
  assert.equal(pushed.length, 3);
  assert.equal(result.pushed, true);
  assert.equal(result.stop, false);
});

test('does not push a successful page once the run budget is spent', async () => {
  const actor = {
    async charge() {
      return { chargedCount: 0, eventChargeLimitReached: true };
    },
    async pushData() {
      throw new Error('should not push');
    },
  };
  const result = await publishPage(actor, { status: 'ok', url: 'https://example.com/' });
  assert.deepEqual(result, { stop: true, pushed: false });
});

test('still pushes when the platform is not in pay-per-event mode', async () => {
  const pushed = [];
  const actor = {
    async charge() {
      return { chargedCount: 0, eventChargeLimitReached: false };
    },
    async pushData(record) {
      pushed.push(record);
    },
  };
  const result = await publishPage(actor, { status: 'ok', url: 'https://example.com/' });
  assert.equal(result.pushed, true);
  assert.equal(result.stop, false);
  assert.equal(pushed.length, 1);
});
