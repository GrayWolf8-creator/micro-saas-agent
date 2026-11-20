export function runStatsRecord(stats = {}) {
  const memoryMbytes = stats.memoryMbytes;
  return {
    cheerioPages: stats.cheerioPages || 0,
    browserPages: stats.browserPages || 0,
    browserMs: stats.browserMs || 0,
    memoryMbytes: typeof memoryMbytes === 'number' && Number.isFinite(memoryMbytes) ? memoryMbytes : null,
  };
}

export async function persistRunStats(actor, stats) {
  const record = runStatsRecord(stats);
  await actor.setValue('RUN_STATS', record);
  return record;
}

export function statusMessageFor(results, stats) {
  const ok = results.filter((record) => record.status === 'ok').length;
  const browserPages = stats?.browserPages || 0;
  return `Extracted ${ok} page(s); wrote ${results.length} dataset row(s); browser pages ${browserPages}.`;
}
