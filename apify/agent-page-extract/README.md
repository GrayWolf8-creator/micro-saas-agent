# Agent Page Extract — website to markdown for AI agents and RAG

Give **Agent Page Extract** a URL. It returns the page as clean, LLM-ready Markdown (or plain text) with the navigation, footer, ads, and cookie banner removed. Use it as a webpage to markdown step in a RAG pipeline, as an AI agent web reader, or as an html to markdown converter that stays cheap on static pages and only opens a browser when the page is actually JavaScript-rendered.

One dataset row per page: URL, title, description, markdown, optional text, word count, token estimate, optional links, fetch time, and status.

## What it does

1. Fetches the page with [Crawlee](https://crawlee.dev/) **CheerioCrawler** (a plain HTTP fetch, no browser).
2. If that HTML is empty or still a JavaScript shell, and **browser fallback** is on, renders it once with **PlaywrightCrawler**.
3. Removes nav, footer, ads, cookie banners, and any extra CSS selectors you pass.
4. Extracts the main article with Mozilla Readability and converts it with Turndown.
5. Writes the row to the default dataset. A successful row (`status: "ok"`) is the billable page.

Public pages only. The actor does not log in, does not solve bot checks, and does not follow a page that is clearly a "verify you are human" interstitial. Those rows are `blocked` and are not billed as extracted pages.

## Use cases

- **RAG scraper.** Turn documentation, help centers, and blogs into chunks you can embed.
- **AI agent web reader.** Hand an agent one URL, or a short same-host crawl, and let it read Markdown instead of HTML.
- **LLM ready context.** Drop the chrome so the model spends tokens on the article. `tokenEstimate` is `ceil(characters / 4)` on the plain text, a sizing hint rather than a vendor tokenizer.
- **Website to markdown / webpage to markdown.** One page or a small docs crawl (`crawlDepth` 0, 1, or 2).
- **HTML to markdown and clean text extractor.** `outputFormat` is `markdown`, `text`, or `both`.

Crawl scope stays small on purpose: same host as the page that linked it, depth at most 2, at most 200 pages, and up to 100 same-host links discovered per page.

## Pricing

Pay per event. Copy these two events into the Actor's monetization settings (they are also in [`.actor/pay_per_event.json`](.actor/pay_per_event.json)).

| Event | When it is charged | Price |
| --- | --- | --- |
| `actor-start` | Once, when the run starts | **$0.005** |
| `page-extracted` | Once per page with `status: "ok"` | **$0.002** |

Empty pages, robots.txt skips, bot-check interstitials, and fetch errors are stored with a status and are **not** charged as `page-extracted`. The start event is still charged if the run begins.

| Successful pages | What you pay |
| --- | --- |
| 1 | $0.007 |
| 10 (the default cap) | $0.025 |
| 200 (the hard cap) | $0.405 |

Formula: `$0.005 + $0.002 × successful pages`. Set the run's maximum charge at least to `$0.007` so one start plus one page fits. Browser fallback uses more compute than Cheerio; give the run **2048 MB** of memory when fallback is on.

## Input

| Field | Default | What it does |
| --- | --- | --- |
| `startUrls` | required | URL strings or `{ "url": "..." }` objects. `http` and `https` only. |
| `crawlDepth` | `0` | Same-host hops. `0` means only the URLs you listed. Max `2`. |
| `maxPages` | `10` | Pages processed, including non-ok rows. Hard cap `200`. |
| `includeLinks` | `false` | Add article links (`url`, `text`) to the row. |
| `outputFormat` | `markdown` | `markdown`, `text`, or `both`. |
| `removeSelectors` | none | Extra CSS selectors removed before extraction. |
| `useBrowserFallback` | `true` | Render in Chrome only when the cheap fetch is empty or a JS shell. |
| `respectRobotsTxt` | `true` | Obey `robots.txt`. Disallowed URLs are `blocked` and not fetched. |

```json
{
  "startUrls": [{ "url": "https://docs.example.com/guide" }],
  "crawlDepth": 1,
  "maxPages": 20,
  "includeLinks": true,
  "outputFormat": "both",
  "removeSelectors": [".newsletter", "#chat-widget"],
  "useBrowserFallback": true,
  "respectRobotsTxt": true
}
```

## Output

Each page is one item in the default dataset. The **Overview** view shows URL, title, description, status, words, token estimate, and fetch time. Open the **Markdown** view to read the article.

```json
{
  "url": "https://docs.example.com/guide",
  "title": "Getting started",
  "description": "Install the reader and turn a webpage into clean markdown.",
  "markdown": "# Getting started\n\nAgent Page Extract turns a public webpage into clean markdown...",
  "text": "Getting started\n\nAgent Page Extract turns a public webpage into clean markdown...",
  "wordCount": 86,
  "tokenEstimate": 112,
  "links": [
    { "url": "https://docs.example.com/guide/install", "text": "Install the reader" }
  ],
  "fetchedAt": "2026-11-05T23:00:00.000Z",
  "status": "ok"
}
```

`text` is present when `outputFormat` is `text` or `both`. `links` is present when `includeLinks` is true. `markdown` is present when the format is `markdown` or `both`.

| `status` | Meaning | `page-extracted` charge |
| --- | --- | --- |
| `ok` | Main content extracted | Yes |
| `empty` | Fetched, but no article text | No |
| `blocked` | robots.txt, or a bot-check interstitial | No |
| `error` | The fetch failed | No |

## How the fetch stays cheap

Cheerio runs first on every URL. Playwright runs only for pages that came back empty or as a JavaScript shell (`<div id="root">`, "enable JavaScript", and similar) while `useBrowserFallback` is true. A normal article never opens Chrome. A short static note does not either. A bot-check page is not sent to the browser.

The crawler sends `User-Agent: Mozilla/5.0 (compatible; AgentPageExtract/1.0; +https://apify.com)` and, unless you turn it off, checks `robots.txt` for that agent (and for `*`).

## FAQ

**Can I get plain text instead of Markdown?**  
Yes. Set `outputFormat` to `text` or `both`. The clean text extractor uses the same article Readability picked.

**Will it crawl a whole website?**  
No. Depth is 0–2 and the page cap is 200, same host only. That is enough for a docs section, not a full-site mirror.

**Does it execute JavaScript?**  
Only as a fallback, and only when the first fetch has no real article. Turn `useBrowserFallback` off to stay on HTTP.

**Does it respect robots.txt?**  
Yes, by default. Disallowed URLs are marked `blocked` and are not downloaded.

**Why was a page not charged?**  
Only `status: "ok"` fires `page-extracted`. Empty, blocked, and error rows are still in the dataset so you can see what happened.

**What is `tokenEstimate`?**  
`Math.ceil(plainText.length / 4)`. Use it to size a context window. It is not a count from a specific model tokenizer.

**Can it read pages behind a login or a captcha?**  
No. It reads public HTML. A "verify you are human" page is stored as `blocked` and is not rendered in the fallback browser.

**How much memory should a run use?**  
2048 MB when browser fallback is enabled. The Docker image is `apify/actor-node-playwright-chrome`.

## Local tests

From this folder, on Node 20 or newer:

```bash
npm install
npm test
```

The tests serve mock HTML pages on `127.0.0.1` and check extraction, robots.txt, crawl depth, the page cap, and the browser fallback. They do not call Apify, and they do not touch the Render app in the rest of this repository.

## Keywords

website to markdown, webpage to markdown, LLM ready, RAG scraper, AI agent web reader, html to markdown, clean text extractor
