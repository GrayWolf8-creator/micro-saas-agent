import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
const S = await import('../stats.js');

test('OPTIONS preflights on paid routes are counted as preflight, never paid', async () => {
    const before = (await S.getStats(1)).totals;
    S.record('OPTIONS', '/api/rails', 204);
    S.record('OPTIONS', '/api/regime', 200);
    S.record('GET', '/api/rails', 200);
    await S.recordAudience({ route: 'OPTIONS /api/rails', statusCode: 204, ua: 'Mozilla/5.0', paidRoute: true });
    await S.recordAudience({ route: 'GET /api/rails', statusCode: 200, ua: 'Mozilla/5.0', paidRoute: true });
    const s = await S.getStats(1);
    assert.equal(s.totals.paid - before.paid, 1);
    assert.equal(s.totals.preflight - (before.preflight || 0), 2);
    assert.equal(s.totals.requests - before.requests, 3);
    const lb = s.audience.likelyBuyer || s.audience.split?.likelyBuyer;
    if (lb) assert.ok(lb.paid >= 1);
    assert.equal(S.isPreflightRoute('OPTIONS /api/rails'), true);
    assert.equal(S.isPreflightRoute('GET /api/rails'), false);
});
