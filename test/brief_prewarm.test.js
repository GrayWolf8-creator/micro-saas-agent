// Background prewarm, next-close scheduling, and stale-while-revalidate. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOUR_H_MS, BRIEF_REBUILD_DELAY_MS, latestClosed4hBar, nextBriefRebuildAt, briefPrewarmEnabled,
  briefIsServableStale, startBriefPrewarm, createBriefCache, teaserFromBrief
} from '../upgrades.js';

const flush = () => new Promise(r => setImmediate(r));

test('startup prewarm builds immediately and the timer re-arms for the next close', async () => {
  const now = Date.parse('2026-11-19T02:30:00.000Z');
  let builds = 0;
  const timers = [];
  const handle = { unrefed: false, unref() { this.unrefed = true; } };
  const started = startBriefPrewarm({
    now: () => now,
    env: {},
    delayMs: BRIEF_REBUILD_DELAY_MS,
    build: async () => { builds++; return { bar: '2026-11-18T20:00:00.000Z', regime: { score: 1 } }; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return handle; },
    clearTimer: () => {},
    log: () => {}
  });
  assert.equal(started.enabled, true);
  await flush();
  assert.equal(builds, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, Date.parse('2026-11-19T04:00:00.000Z') + BRIEF_REBUILD_DELAY_MS - now);
  assert.equal(handle.unrefed, true);
  timers[0].fn();
  await flush();
  assert.equal(builds, 2);
  assert.equal(timers.length, 2);
  started.stop();
});

test('prewarm stays off under NODE_ENV=test and BRIEF_PREWARM=off', () => {
  let builds = 0;
  const build = async () => { builds++; };
  const boom = () => { throw new Error('timer should not be armed'); };
  assert.equal(briefPrewarmEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(briefPrewarmEnabled({ BRIEF_PREWARM: 'off' }), false);
  assert.equal(briefPrewarmEnabled({ BRIEF_PREWARM: '0' }), false);
  assert.equal(briefPrewarmEnabled({}), true);
  assert.equal(startBriefPrewarm({ env: { NODE_ENV: 'test' }, build, setTimer: boom }).enabled, false);
  assert.equal(startBriefPrewarm({ env: { BRIEF_PREWARM: 'off' }, build, setTimer: boom }).enabled, false);
  assert.equal(builds, 0);
});

test('next rebuild is 75s after the next UTC 4h close', () => {
  assert.equal(BRIEF_REBUILD_DELAY_MS, 75_000);
  assert.ok(BRIEF_REBUILD_DELAY_MS >= 60_000 && BRIEF_REBUILD_DELAY_MS <= 90_000);
  const hours = [0, 4, 8, 12, 16, 20];
  for (const hour of hours) {
    const justAfter = Date.UTC(2026, 10, 19, hour, 0, 30);
    const at = new Date(nextBriefRebuildAt(justAfter, 90_000));
    assert.equal(at.getUTCHours(), hour);
    assert.equal(at.getUTCMinutes(), 1);
    assert.equal(at.getUTCSeconds(), 30);
    const late = Date.UTC(2026, 10, 19, hour, 2, 0);
    const following = new Date(nextBriefRebuildAt(late, BRIEF_REBUILD_DELAY_MS));
    assert.equal(following.getUTCHours(), (hour + 4) % 24);
    assert.equal(following.getUTCMinutes(), 1);
    assert.equal(following.getUTCSeconds(), 15);
  }
  const mid = Date.parse('2026-11-19T02:30:00.000Z');
  assert.equal(nextBriefRebuildAt(mid), Date.parse('2026-11-19T04:01:15.000Z'));
  assert.equal(latestClosed4hBar(mid).barClose, '2026-11-19T00:00:00.000Z');
});

test('a request during the next-bar build gets the previous brief, unless it is more than one bar old', async () => {
  let now = Date.parse('2026-11-19T02:30:00.000Z');
  let release = () => {};
  let gate = new Promise(r => { release = r; });
  let calls = 0;
  const get = createBriefCache({
    now: () => now,
    log: () => {},
    build: async (bar) => {
      calls++;
      if (calls > 1) await gate;
      return { bar: bar.bar, barClose: bar.barClose, asOf: bar.barClose, regime: { score: calls } };
    }
  });
  const first = await get();
  assert.equal(first.bar, '2026-11-18T20:00:00.000Z');
  assert.equal(calls, 1);

  now = Date.parse('2026-11-19T04:00:00.000Z');
  const expected = '2026-11-19T00:00:00.000Z';
  assert.equal(briefIsServableStale(first, expected), true);
  const served = await get();
  const also = await get();
  assert.equal(served, first);
  assert.equal(also, first);
  assert.equal(served.bar, '2026-11-18T20:00:00.000Z');
  assert.equal(served.barClose, '2026-11-19T00:00:00.000Z');
  assert.equal(served.asOf, '2026-11-19T00:00:00.000Z');
  await flush();
  assert.equal(calls, 2);
  release();
  await flush();
  const fresh = await get();
  assert.equal(fresh.bar, expected);
  assert.equal(fresh.barClose, '2026-11-19T04:00:00.000Z');
  assert.equal(calls, 2);

  now = Date.parse('2026-11-19T12:00:00.000Z');
  const tooOldExpected = latestClosed4hBar(now).bar;
  assert.equal(briefIsServableStale(fresh, tooOldExpected), false);
  assert.equal(Date.parse(tooOldExpected) - Date.parse(fresh.bar) > FOUR_H_MS, true);
  gate = new Promise(r => { release = r; });
  let resolved = false;
  const waited = get().then(v => { resolved = true; return v; });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(resolved, false);
  assert.equal(calls, 3);
  release();
  const late = await waited;
  assert.equal(late.bar, tooOldExpected);
  assert.equal(calls, 3);
});

test('a failed rebuild is logged, does not crash, and leaves the last good brief in place', async () => {
  let now = Date.parse('2026-11-19T02:30:00.000Z');
  let fail = false;
  const logs = [];
  const get = createBriefCache({
    now: () => now,
    log: (...parts) => logs.push(parts.join(' ')),
    build: async (bar) => {
      if (fail) return { error: 'upstream data unavailable, retry shortly' };
      return { bar: bar.bar, barClose: bar.barClose, asOf: bar.barClose, regime: { score: 3 } };
    }
  });
  const good = await get();
  fail = true;
  now = Date.parse('2026-11-19T04:00:00.000Z');
  assert.equal(await get(), good);
  await flush();
  assert.match(logs.join('\n'), /build failed/);
  assert.equal(await get(), good);
  assert.equal(good.bar, '2026-11-18T20:00:00.000Z');

  now = Date.parse('2026-11-19T12:00:00.000Z');
  const err = await get();
  assert.equal(err.error, 'upstream data unavailable, retry shortly');
  now = Date.parse('2026-11-19T02:30:00.000Z');
  const restored = await get();
  assert.equal(restored, good);

  const background = [];
  const started = startBriefPrewarm({
    now: () => now,
    env: {},
    build: async () => { throw new Error('boom'); },
    setTimer: () => ({ unref() {} }),
    log: (...parts) => background.push(parts.join(' '))
  });
  await flush();
  assert.equal(started.enabled, true);
  assert.match(background.join('\n'), /boom/);
  started.stop();
});

test('the free teaser is read from the cached brief, including an older bar', () => {
  const brief = {
    date: '2026-11-18',
    builtAt: '2026-11-19T00:02:00.000Z',
    asOf: '2026-11-19T00:00:00.000Z',
    bar: '2026-11-18T20:00:00.000Z',
    barClose: '2026-11-19T00:00:00.000Z',
    regime: { score: 3, outOf: 4, checks: { etfInflows: 'pass', btcQuietSupport: 'fail' } },
    dots: { asOf: '2026-11-19T00:02:00.000Z', green: 4, red: 1 },
    top10ByDotStrength: [
      { name: 'LINK', kind: 'green', band: 'outer', wt1: -70, latest: true },
      { name: 'AAVE', kind: 'red', band: 'inner', wt1: 55, latest: false },
      { name: 'SOL', kind: 'green', band: 'inner', wt1: -54, latest: false }
    ]
  };
  const teaser = teaserFromBrief(brief, { track: null });
  assert.equal(teaser.free, true);
  assert.equal(teaser.bar, brief.bar);
  assert.equal(teaser.barClose, brief.barClose);
  assert.equal(teaser.asOf, brief.asOf);
  assert.equal(teaser.builtAt, brief.builtAt);
  assert.equal(teaser.regime.score, 3);
  assert.equal(teaser.regime.label, 'risk-on');
  assert.equal(teaser.regime.checks.etfInflows, 'pass');
  assert.equal(teaser.regime.checks.btcQuietSupport, 'fail');
  assert.deepEqual(teaser.top3, ['LINK', 'AAVE', 'SOL']);
  assert.equal(teaser.dots.green, 4);
  assert.equal(teaser.dots.red, 1);
  assert.equal(Object.hasOwn(teaser.top3Dots[0], 'wt1'), false);
});
