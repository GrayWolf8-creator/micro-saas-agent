// Bazaar discovery helpers. CDP ranks a resource on query relevance plus metadata quality:
// a natural-language description, topical tags, and an input/output schema whose fields are described.
// schemaFromExample used to emit types with no descriptions. ensureDescribed fills any field still blank.

export function schemaFromExample(value, depth = 0) {
    if (value == null || depth > 5) return {};
    if (Array.isArray(value)) return { type: 'array', items: value.length ? schemaFromExample(value[0], depth + 1) : { type: 'object' } };
    if (typeof value === 'object') {
        const properties = {};
        for (const [k, v] of Object.entries(value)) properties[k] = schemaFromExample(v, depth + 1);
        return { type: 'object', properties };
    }
    if (typeof value === 'boolean') return { type: 'boolean' };
    if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
    return { type: 'string' };
}

export function cloneSchema(value) {
    return JSON.parse(JSON.stringify(value));
}

function words(key) {
    return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase();
}

export function fieldSentence(key, kind) {
    const name = words(key);
    const sentence = kind === 'input'
        ? `${name} input for this paid call.`
        : `The ${name} field in this route's paid JSON.`;
    return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function ensureDescribed(node, kind = 'output') {
    if (!node || typeof node !== 'object') return node;
    if (node.properties && typeof node.properties === 'object') {
        for (const [k, v] of Object.entries(node.properties)) {
            if (!v || typeof v !== 'object') continue;
            if (typeof v.description !== 'string' || !v.description.trim()) v.description = fieldSentence(k, kind);
            ensureDescribed(v, kind);
            if (v.items && typeof v.items === 'object') {
                if (typeof v.items.description !== 'string' || !v.items.description.trim()) v.items.description = fieldSentence(k + ' item', kind);
                ensureDescribed(v.items, kind);
            }
        }
    }
    return node;
}

export function applyFieldDocs(schema, docs) {
    if (!schema || !docs) return schema;
    if (typeof docs.description === 'string' && !schema.description) schema.description = docs.description;
    const fields = docs.fields || {};
    if (schema.properties) {
        for (const [k, text] of Object.entries(fields)) {
            if (typeof text === 'string' && schema.properties[k] && !schema.properties[k].description) schema.properties[k].description = text;
        }
    }
    return schema;
}

// Pathname rules, first match wins. Hand-written output schemas (verdict, deep, brief, bottom, which-rail, fuel)
// already carry a description; ensureDescribed fills any property that is still blank.
const RULES = [
    [/^\/api\/brief\/weekly/, {
        description: 'Weekly crypto brief subscription: how many Monday webhook issues were purchased.',
        fields: {
            subscriptionId: 'Id of the weekly crypto brief subscription.',
            plan: 'Plan id. 4w is four Monday issues.',
            issuesLeft: 'Monday crypto brief issues remaining.',
            expiresAt: 'When the weekly crypto brief subscription ends.',
            note: 'The webhook secret is returned once, on subscribe.'
        }
    }],
    [/^\/api\/daily\/?$/, {
        description: 'Daily bundle: the daily crypto brief plus the full crypto market regime.',
        fields: {
            bundle: 'True when this payload is the brief plus the full regime.',
            priceUsd: 'Bundle price in USD. 0.025, below the $0.03 separate price.',
            separateUsd: 'Price of buying the brief and the regime as two calls. 0.03.',
            brief: 'The daily crypto brief: regime score, dots, top coins, and BTC/ETH/SOL flows.',
            regime: 'Full crypto market regime checks, raw values, and rules.'
        }
    }],
    [/^\/api\/brief\/?$/, {
        description: 'Daily crypto brief: crypto market regime, WaveTrend dots, top coins, and BTC/ETH/SOL flows.',
        fields: {
            date: 'Mountain Time date this daily crypto brief covers.',
            regime: 'Crypto market regime score included in the daily brief.',
            dots: 'Green and red WaveTrend band-dot counts for the day.',
            top10ByDotStrength: 'Top coins by WaveTrend dot strength in this daily crypto brief.',
            flowsSummary: 'BTC, ETH, and SOL Kraken large-print flow bias for the day.'
        }
    }],
    [/^\/api\/regime/, {
        description: 'Crypto market regime score from 0 to 4 and the checks behind it.',
        fields: {
            score: 'Crypto market regime score from 0 to 4. Higher is more risk-on.',
            outOf: 'Maximum crypto market regime score. Always 4.',
            checks: 'ETF flow, BTC support, alt breadth, and Fear and Greed checks, each pass or fail.'
        }
    }],
    [/^\/api\/dots/, {
        description: 'Current WaveTrend oversold and overbought band dots on Kraken 4h pairs.',
        fields: {
            asOf: 'When this WaveTrend band-dot scan was computed.',
            bandDots: 'Oversold (green) and overbought (red) WaveTrend band dots in the last 6 closed 4h bars.'
        }
    }],
    [/^\/api\/history/, {
        description: 'Simulated WaveTrend band-dot hit rates over 90 days.',
        fields: {
            window: 'Backtest window. 90 days of Kraken 4h bars.',
            methodology: 'simulated backtest. Not a live trade log.',
            summary: 'Hit rate and average forward move for green and red WaveTrend dots.',
            dots: 'Each band dot with forward percent at 4h, 24h, and 3d when those bars exist.'
        }
    }],
    [/^\/api\/coin\//, {
        description: 'WaveTrend 4h snapshot for one Kraken USD coin.',
        fields: {
            name: 'Coin symbol, for example BTC.',
            wt1: 'WaveTrend wt1 on the latest closed Kraken 4h bar.',
            wt2: 'WaveTrend wt2 signal line on that bar.',
            prevWt1: 'WaveTrend wt1 on the previous closed 4h bar.',
            prevWt2: 'WaveTrend wt2 on the previous closed 4h bar.',
            dots: 'Recent oversold or overbought band dots for this coin.'
        }
    }],
    [/^\/api\/flows\//, {
        description: 'Kraken large-print buy versus sell summary joined to the WaveTrend 4h state.',
        fields: {
            symbol: 'Coin the large-print flow summary covers.',
            flows: 'Large-print count, buy USD, sell USD, net USD, and the resulting bias.',
            wavetrend: 'WaveTrend 4h wt1, wt2, and zone for the same coin.'
        }
    }],
    [/^\/api\/rwa/, {
        description: 'Tokenized real-world-asset TVL, flows, movers, and yields.',
        fields: {
            asOf: 'When the tokenized RWA snapshot was read.',
            summary: 'Total RWA TVL and the 7-day net change.',
            topProtocolsByTvl: 'Largest tokenized RWA protocols by TVL.',
            yields: 'RWA yield pools, including symbol and APY when the source has them.',
            sources: 'Public source URLs for the RWA snapshot.'
        }
    }],
    [/^\/api\/govcontracts/, {
        description: 'US federal government contract awards. Not a crypto market feed.',
        fields: {
            window: 'Start and end dates of the government-contracts window.',
            count: 'How many federal contract awards matched the filters.',
            note: 'Defense awards reach USAspending about 90 days late.',
            awards: 'Matching government contracts: recipient, ticker, sector, amount, agency, date, and link.'
        }
    }],
    [/^\/api\/kraken\/listings/, {
        description: 'Kraken USD pairs listed in the last 30 days, with price and WaveTrend state.',
        fields: {
            liveSince: 'When this Kraken listings feed started recording first-seen dates.',
            count: 'How many new USD pairs are in the window.',
            newUsdPairs: 'Each new Kraken USD pair: first trade day, price, 24h volume, change since listing, and WaveTrend 4h.'
        }
    }],
    [/^\/api\/rules/, {
        description: 'CFTC and SEC crypto rule changes from the last 90 days.',
        fields: {
            count: 'How many crypto rule documents are in the window.',
            openComments: 'Rulemakings whose comment period is still open.',
            rows: 'Each CFTC or SEC document: date, type, RIN, comment deadline, and stage change.'
        }
    }],
    [/^\/api\/rs\/?$/, {
        description: 'Relative strength and sector breadth for 66 Kraken USD pairs.',
        fields: {
            universe: 'How many Kraken USD pairs are in the relative-strength universe.',
            scored: 'How many pairs had both a 1-week and a 1-month return.',
            breadth: 'Share of scored coins with a positive 1-month return.',
            leaders: 'Strongest symbols in this relative-strength read.',
            sectors: 'Sector score, breadth, and the sector leader.',
            coins: 'Per-coin 1-week and 1-month returns, percentile ranks, and the 0-100 strength score.'
        }
    }],
    [/^\/api\/rails\/route/, null],
    [/^\/api\/rails/, {
        description: 'Payment rails compared for one USD amount: fee, speed, and the recommended pick.',
        fields: {
            amountUsd: 'USD amount the payment rails were priced for.',
            recommended: 'Cheapest payment rail for this amount, and which rail is fastest.',
            rails: 'Each payment rail with fee USD, fee percent, settlement time, and live or static status.'
        }
    }],
    [/^\/api\/value\/[^/]+\/history/, {
        description: 'Weekly value-capture snapshots for one coin.',
        fields: {
            symbol: 'Ticker these value-capture snapshots cover.',
            name: 'Display name of the coin.',
            weeks: 'How many weekly snapshots were returned, up to 52.',
            snapshots: 'One value-capture score per week. Yield is recomputed; rule classes are carried forward.',
            note: 'What is recomputed versus carried forward on older weeks.',
            disclaimer: 'Tokenomics data and a score. Not investment advice.'
        }
    }],
    [/^\/api\/value\/[^/]+/, {
        description: 'Value-capture tokenomics score for one coin.',
        fields: {
            symbol: 'Ticker this value-capture score covers.',
            name: 'Display name of the coin.',
            score: 'Value-capture score from 0 to 100.',
            grade: 'strong, medium, weak, or fail, from the score.',
            components: 'Net supply, holder yield, usage class, burn-versus-held, and unlock overhang.',
            unverified: 'Inputs that were missing and did not earn points.',
            disclaimer: 'Tokenomics data and a score. Not investment advice.'
        }
    }],
    [/^\/api\/value\/?$/, {
        description: 'Value-capture screen across the covered coins.',
        fields: {
            count: 'How many coins are in this value-capture screen.',
            rows: 'One value-capture score per coin, sorted as requested.',
            sort: 'Sort that was applied: score, yield, or netSupply90d.',
            minScore: 'Minimum score kept in this screen.',
            disclaimer: 'Tokenomics data and scores. Not investment advice.'
        }
    }],
    [/^\/api\/growth\/history/, {
        description: 'Weekly growth-lane snapshots and the week each rule first passed.',
        fields: {
            asOf: 'When the growth-lane history was computed.',
            window: 'Lookback on each snapshot. 90d.',
            weeks: 'How many weekly growth-lane snapshots were returned.',
            snapshots: 'Per week: week ending, BTC 90-day return, and the filtered rows.',
            firstFlip: 'The week each growth-lane rule first passed.',
            disclaimer: 'On-chain growth data and rule flags. Not investment advice.'
        }
    }],
    [/^\/api\/growth\/?$/, {
        description: 'Growth-lane screen across covered chains and apps.',
        fields: {
            asOf: 'When this growth-lane screen was computed.',
            window: 'Lookback. 90d.',
            count: 'How many chains or apps matched the filters.',
            rows: 'Each row has rulesPassed, state, and the stables, fees, TVL, and relative-return flags.',
            minTvlUsd: 'Minimum TVL filter, in USD.',
            disclaimer: 'On-chain growth data and rule flags. Not investment advice.'
        }
    }],
    [/^\/api\/growth\//, {
        description: 'Growth-lane rules for one chain or app.',
        fields: {
            chain: 'Chain or app id this growth-lane read covers.',
            state: 'none, early, confirmed, or trigger_only.',
            rulesPassed: 'How many of the four growth-lane rules passed.',
            rules: 'Stables, fees, TVL versus price, and the relative-return flag.',
            window: 'Lookback. 90d.',
            disclaimer: 'On-chain growth data and rule flags. Not investment advice.'
        }
    }],
    [/^\/api\/pay\/should-i-pay/, {
        description: 'One pay, dont_pay, or ask_human verdict from spend policy and seller reputation.',
        fields: {
            engine: 'Rule engine id for the should-I-pay decision.',
            verdict: 'pay, dont_pay, or ask_human.',
            reasons: 'Which spend-policy or seller-reputation rule produced the verdict.',
            spend: 'Spend-policy sub-result. allow, deny, or needs_approval.',
            seller: 'Seller-reputation sub-result: verdict and 0-100 score.',
            decisionReceipt: 'Signed receipt bound to this should-I-pay verdict.'
        }
    }],
    [/^\/api\/spend\/check/, {
        description: 'Spend-policy decision: allow, deny, or needs_approval, plus the rules that fired.',
        fields: {
            engine: 'Rule engine id for the spend-policy check.',
            decision: 'allow, deny, or needs_approval.',
            reasons: 'Rules that fired on this proposed payment.',
            checks: 'Every spend-policy check and whether it passed.',
            remaining: 'Per-transaction and rolling-cap room after this payment.',
            decisionReceipt: 'Signed receipt bound to this spend-policy decision.'
        }
    }],
    [/^\/api\/seller\/reputation/, {
        description: 'x402 seller reputation: a 0-100 score and trusted, caution, avoid, or unknown.',
        fields: {
            engine: 'Rule engine id for the seller-reputation score.',
            verdict: 'trusted, caution, avoid, or unknown.',
            score: 'Seller reputation score from 0 to 100.',
            components: 'Distinct buyers, wash share, wallet age, top-payer concentration, and 30-day volume.',
            reasons: 'Plain-language reasons for the seller-reputation verdict.',
            reputationReceipt: 'Signed receipt bound to this seller-reputation result.'
        }
    }],
    [/^\/api\/pass\/day/, {
        description: 'Day pass token that unlocks paid data routes for 24 hours.',
        fields: {
            pass: 'Day-pass token. Send it as the X-GW8-Pass header. Shown once.',
            expiresAt: 'When this day pass stops working.',
            header: 'Header name to send the day-pass token on. X-GW8-Pass.'
        }
    }],
    [/^\/api\/alerts\/subscribe/, {
        description: 'Webhook subscription for new green WaveTrend band dots.',
        fields: {
            subscriptionId: 'Id of the green-dot alert subscription.',
            filter: 'Which green dots wake the webhook: outer, inner, or all.',
            expiresAt: 'When the alert subscription ends.',
            alertsLeft: 'Alert deliveries remaining on this subscription.',
            note: 'The webhook secret is returned once, on subscribe.'
        }
    }],
    [/^\/api\/agent\/?$/, {
        description: 'Crypto market regime score plus WaveTrend band dots on 66 Kraken 4h pairs.',
        fields: {
            status: 'success when the crypto market regime and WaveTrend snapshot is included.',
            signal: 'Stage 1 crypto market regime score and WaveTrend band dots.'
        }
    }]
];

export function outputDocsFor(pathname) {
    const path = String(pathname || '');
    for (const [re, docs] of RULES) if (re.test(path)) return docs;
    return null;
}
