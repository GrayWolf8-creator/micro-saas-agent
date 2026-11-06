// Agent Page Extract: URLs in, LLM-ready Markdown out.
// CheerioCrawler fetches each page first. PlaywrightCrawler runs only when the
// HTML is empty or a JavaScript shell and useBrowserFallback is true.
// Pay per event: actor-start once, then page-extracted for each status "ok" row.
import { Actor, log } from 'apify';
import { extractSite } from './crawl.js';
import { normalizeInput } from './input.js';
import { CHARGE_EVENTS, publishPage } from './publish.js';

await Actor.init();

let exitCode = 0;
let statusMessage;
try {
  const input = normalizeInput((await Actor.getInput()) ?? {});
  log.info(`Agent Page Extract: ${input.startUrls.length} start URL(s), depth ${input.crawlDepth}, max ${input.maxPages} page(s).`);

  const startCharge = await Actor.charge({ eventName: CHARGE_EVENTS.start });
  if (startCharge?.chargedCount === 0 && startCharge?.eventChargeLimitReached) {
    statusMessage = 'Run budget is below the actor-start price. Nothing was fetched.';
    log.warning(statusMessage);
  } else {
    const { results } = await extractSite(input, {
      onPage: (record) => publishPage(Actor, record),
    });
    const ok = results.filter((record) => record.status === 'ok').length;
    statusMessage = `Extracted ${ok} page(s); wrote ${results.length} dataset row(s).`;
    log.info(statusMessage);
  }
} catch (error) {
  exitCode = 1;
  statusMessage = error instanceof Error ? error.message : String(error);
  log.exception(error, 'Agent Page Extract failed');
}

await Actor.exit({ exitCode, statusMessage });
