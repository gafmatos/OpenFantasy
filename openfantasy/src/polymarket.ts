type RawMarket = {
    id: string;
    question: string;
    outcomes: string;        // JSON string, e.g. '["Yes","No"]'
    outcomePrices: string;   // JSON string, e.g. '["0.62","0.38"]'
    clobTokenIds: string;    // JSON string of token id strings
    closed: boolean;
    acceptingOrders: boolean;
    spread?: number;         // may be missing on some markets
};

type RawEvent = {
    title?: string;
    markets?: RawMarket[];   // events can come back with no markets
};

export type Market  = {
    id: string;
    question: string; 
    outcomes: string[]; 
    prices: number[];
    spread: number; 
    tokenIds: string[];


    
}

function parseMarket(raw: RawMarket): Market | null {
    if (raw.closed !== false || raw.acceptingOrders !== true) return null;
    if (raw.spread === undefined || raw.spread > 0.10) return null;

    let outcomes: string[];
    let prices: number[];
    let tokenIds: string[];
    try {
        outcomes = JSON.parse(raw.outcomes);
        prices = (JSON.parse(raw.outcomePrices) as string[]).map(Number);
        tokenIds = JSON.parse(raw.clobTokenIds);
    } catch {
        return null;
    }

    if (
        !Array.isArray(outcomes) ||
        outcomes.length === 0 ||
        outcomes.length !== prices.length ||
        outcomes.length !== tokenIds.length ||
        prices.some(Number.isNaN)
    ) {
        return null;
    }

    return {
        id: raw.id,
        question: raw.question,
        outcomes,
        prices,
        spread: raw.spread,
        tokenIds,
    };
}


const GAMMA_URL = "https://gamma-api.polymarket.com";
const MAX_RESULTS = 3;

// Returns null when the market is closed, thin, or malformed (parseMarket rejected it).
export async function getMarket(id: string): Promise<Market | null> {
    const res = await fetch(`${GAMMA_URL}/markets/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Polymarket market ${id} failed: ${res.status}`);
    return parseMarket((await res.json()) as RawMarket);
}

// Most active open markets right now. UNVERIFIED against the live API: the
// order=volume24hr parameter could not be checked from the dev sandbox.
export async function topMarkets(): Promise<Market[]> {
    const res = await fetch(
        `${GAMMA_URL}/markets?closed=false&order=volume24hr&ascending=false&limit=30`,
        { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`Polymarket top markets failed: ${res.status}`);
    const raws = (await res.json()) as RawMarket[];
    const markets: Market[] = [];
    for (const raw of raws) {
        const market = parseMarket(raw);
        if (market) markets.push(market);
        if (markets.length === MAX_RESULTS) break;
    }
    return markets;
}

export async function searchMarkets(query: string): Promise<Market[]> {
    // Filler words like "odds" get matched literally by Polymarket's search
    // ("Odds BK" markets), so search with the meaningful words only.
    const tokens = queryTokens(query);
    const q = tokens.length > 0 ? tokens.join(" ") : query;

    // events_status=active skips finished events before ranking; without it the
    // top 5 events are often all closed and every market gets filtered out.
    const res = await fetch(`${GAMMA_URL}/public-search?q=${encodeURIComponent(q)}&events_status=active`, {
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Polymarket search failed: ${res.status}`);

    const body = (await res.json()) as { events?: RawEvent[] };
    const scored: { market: Market; score: number }[] = [];
    for (const event of body.events ?? []) {
        for (const raw of event.markets ?? []) {
            const market = parseMarket(raw);
            if (!market) continue;
            scored.push({ market, score: relevance(tokens, `${market.question} ${event.title ?? ""}`) });
        }
    }

    // An event lists one market per team/option in the API's own order, so the
    // first few are not the ones asked about. Rank by overlap with the query
    // (stable sort keeps API order for ties).
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    return scored
        .filter((s) => best === 0 || s.score > 0)
        .slice(0, MAX_RESULTS)
        .map((s) => s.market);
}

// "win" is kept on purpose: it separates "win the championship" from "advance to the quarters".
const STOPWORDS = new Set([
    "odds", "the", "will", "what", "are", "is", "of", "by", "in", "on", "at", "a", "an",
    "to", "for", "chance", "chances", "probability", "and", "or", "does", "do",
]);

function words(text: string): string[] {
    return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function queryTokens(query: string): string[] {
    return words(query).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

function relevance(tokens: string[], text: string): number {
    const present = new Set(words(text));
    return tokens.filter((t) => present.has(t)).length;
}