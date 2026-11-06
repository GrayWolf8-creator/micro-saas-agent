import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

test('pay-per-event prices match the store listing', async () => {
  const pricing = await readJson('../.actor/pay_per_event.json');
  assert.equal(pricing['actor-start'].eventPriceUsd, 0.005);
  assert.equal(pricing['page-extracted'].eventPriceUsd, 0.002);
  assert.equal(pricing['page-extracted'].isPrimaryEvent, true);
  assert.equal(pricing['actor-start'].isOneTimeEvent, true);
});

test('actor manifest points at the schemas and the playwright image inputs', async () => {
  const actor = await readJson('../.actor/actor.json');
  const input = await readJson('../.actor/input_schema.json');
  const dataset = await readJson('../.actor/dataset_schema.json');
  assert.equal(actor.name, 'agent-page-extract');
  assert.equal(actor.dockerfile, '../Dockerfile');
  assert.equal(actor.input, './input_schema.json');
  assert.equal(actor.storages.dataset, './dataset_schema.json');
  assert.equal(input.properties.crawlDepth.default, 0);
  assert.equal(input.properties.maxPages.default, 10);
  assert.equal(input.properties.maxPages.maximum, 200);
  assert.equal(input.properties.useBrowserFallback.default, true);
  assert.equal(input.properties.respectRobotsTxt.default, true);
  assert.deepEqual(input.properties.outputFormat.enum, ['markdown', 'text', 'both']);
  assert.ok(input.required.includes('startUrls'));
  assert.equal(dataset.views.overview.title, 'Overview');
  assert.ok(dataset.views.overview.transformation.fields.includes('tokenEstimate'));
  assert.equal(dataset.views.overview.display.component, 'table');
});
