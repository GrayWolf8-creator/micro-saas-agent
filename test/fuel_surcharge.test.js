// EIA diesel surcharge. The page fixture is the public weekly table shape. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCategory } from '../catalog.js';
import { FUEL_SURCHARGE_PRICE_USD, usdAtomic } from '../prices.js';
import {
  parseDieselHtml, validFuelQuery, buildFuelQuote, nextMondayTuesdayRelease, etClockToUtc, isFederalHoliday,
  loadDiesel, _resetDieselCache, FUEL_BLURB, FUEL_TAGS, FUEL_SERVICE_NAME, FUEL_EXAMPLE, FUEL_OUTPUT_SCHEMA, DIESEL_SOURCE
} from '../diesel.js';

const HTML = `<p>Diesel Fuel Release Date: November 10, 2026</p><p>Next Release Date: November 17, 2026</p>
<table><caption>U.S. On-Highway Diesel Fuel Prices*(dollars per gallon)</caption>
<tr><th></th><th>10/26/26</th><th>11/02/26</th><th>11/09/26</th><th>week ago</th></tr>
<tr><td>U.S.</td><td>6.352</td><td>6.292</td><td>6.127</td><td>-0.165</td></tr>
<tr><td>East Coast (PADD1)</td><td>6.079</td><td>6.025</td><td>5.920</td><td>-0.105</td></tr>
<tr><td>New England (PADD1A)</td><td>6.421</td><td>6.416</td><td>6.349</td><td>-0.067</td></tr>
<tr><td>Rocky Mountain (PADD4)</td><td>6.521</td><td>6.445</td><td>6.206</td><td>-0.239</td></tr>
<tr><td>West Coast (PADD5)</td><td>7.329</td><td>7.272</td><td>7.110</td><td>-0.162</td></tr>
<tr><td>California</td><td>8.155</td><td>8.076</td><td>7.897</td><td>-0.179</td></tr>
</table>`;

const NOW = Date.parse('2026-11-16T18:00:00.000Z');

test('parse the weekly page: PADD 4 default inputs, week-over-week, release date, no California row', () => {
  const snap = parseDieselHtml(HTML, NOW);
  assert.equal(snap.releaseDate, '2026-11-10');
  assert.equal(snap.nextReleaseDate, '2026-11-17');
  assert.equal(snap.weekEnding, '2026-11-09');
  assert.equal(snap.regions.padd4.pricePerGallon, 6.206);
  assert.equal(snap.regions.padd4.previousPricePerGallon, 6.445);
  assert.equal(snap.regions.padd4.weekOverWeek, -0.239);
  assert.equal(snap.regions.us.weekOverWeek, -0.165);
  assert.equal(snap.regions.padd1a.pricePerGallon, 6.349);
  assert.equal(snap.regions.california, undefined);
  assert.equal(snap.source, 'Source: U.S. EIA');
  const q = buildFuelQuote(snap, { padd: 'padd4', base: 5.5, mpg: 6 });
  assert.equal(q.surchargePerMile, 0.117667);
  assert.equal(q.region, 'Rocky Mountain (PADD4)');
  assert.equal(q.source, DIESEL_SOURCE);
  assert.equal(buildFuelQuote(snap, { padd: 'padd4', base: 7, mpg: 6 }).surchargePerMile, 0);
  assert.equal(parseDieselHtml('<p>no table</p>'), null);
});

test('validate padd, base, and mpg', () => {
  assert.deepEqual(validFuelQuery({ base: '5.5', mpg: '6' }), { padd: 'padd4', base: 5.5, mpg: 6 });
  assert.equal(validFuelQuery({ padd: 'rocky mountain', base: 0, mpg: 5.5 }).padd, 'padd4');
  assert.equal(validFuelQuery({ padd: 'PADD 1A', base: 4, mpg: 6 }).padd, 'padd1a');
  assert.equal(validFuelQuery({ padd: 'us', base: 4, mpg: 6 }).padd, 'us');
  assert.match(validFuelQuery({ padd: 'california', base: 4, mpg: 6 }).error, /PADD/);
  assert.match(validFuelQuery({ padd: '4', mpg: 6 }).error, /base/);
  assert.match(validFuelQuery({ base: 4 }).error, /mpg/);
  assert.ok(validFuelQuery({ base: -1, mpg: 6 }).error);
  assert.ok(validFuelQuery({ base: 4, mpg: 0 }).error);
  assert.ok(validFuelQuery({ base: 'nope', mpg: 6 }).error);
});

test('refresh after the Monday release, or Tuesday when Monday is a federal holiday', () => {
  assert.equal(isFederalHoliday('2026-05-25'), true);
  assert.equal(isFederalHoliday('2026-11-16'), false);
  const mondayMorning = Date.parse('2026-11-16T16:00:00.000Z');
  assert.equal(nextMondayTuesdayRelease(mondayMorning), etClockToUtc('2026-11-16', 17, 30));
  const afterMonday = etClockToUtc('2026-11-16', 18, 0);
  assert.equal(nextMondayTuesdayRelease(afterMonday), etClockToUtc('2026-11-23', 17, 30));
  const memorialMorning = Date.parse('2026-05-25T15:00:00.000Z');
  assert.equal(nextMondayTuesdayRelease(memorialMorning), etClockToUtc('2026-05-26', 17, 30));
  const snap = parseDieselHtml(HTML, NOW);
  assert.equal(snap.refreshAt, etClockToUtc('2026-11-17', 17, 30));
});

test('cache holds until the release instant and serves the last snapshot if the refresh fails', async () => {
  _resetDieselCache();
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n > 1) throw new Error('down');
    return { ok: true, text: async () => HTML };
  };
  const first = await loadDiesel({ fetch: fetchImpl, now: NOW });
  assert.equal(first.cached, false);
  assert.equal(first.regions.padd4.pricePerGallon, 6.206);
  const held = await loadDiesel({ fetch: fetchImpl, now: NOW + 60_000 });
  assert.equal(held.cached, true);
  assert.equal(n, 1);
  const stale = await loadDiesel({ fetch: fetchImpl, now: etClockToUtc('2026-11-17', 18, 0) });
  assert.equal(stale.stale, true);
  assert.equal(stale.regions.us.pricePerGallon, 6.127);
  _resetDieselCache();
  const down = await loadDiesel({ fetch: async () => { throw new Error('down'); }, now: NOW });
  assert.equal(down, null);
});

test('bazaar copy credits EIA and stays inside the description cap', () => {
  assert.equal(FUEL_SURCHARGE_PRICE_USD, '0.005');
  assert.equal(usdAtomic(FUEL_SURCHARGE_PRICE_USD), '5000');
  assert.ok(FUEL_SERVICE_NAME.length <= 32);
  assert.equal(FUEL_TAGS.length, 5);
  const d = withCategory('/api/truck/fuel-surcharge', FUEL_BLURB);
  assert.ok(d.length <= 500, String(d.length));
  assert.equal(d.endsWith('...'), false);
  assert.match(d, /Source: U\.S\. EIA/);
  assert.match(d, /PADD 4/);
  assert.match(FUEL_BLURB, /\$0\.005/);
  assert.equal(FUEL_EXAMPLE.surchargePerMile, 0.117667);
  assert.equal(FUEL_EXAMPLE.source, 'Source: U.S. EIA');
  assert.ok(FUEL_OUTPUT_SCHEMA.required.includes('surchargePerMile'));
  assert.ok(FUEL_OUTPUT_SCHEMA.required.includes('releaseDate'));
});
