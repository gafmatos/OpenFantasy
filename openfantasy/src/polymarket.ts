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

export async function searchMarkets(query: string): Promise<Market[]> {
    const res = await fetch(`${GAMMA_URL}/public-search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Polymarket search failed: ${res.status}`);

    const body = (await res.json()) as { events?: RawEvent[] };
    const markets: Market[] = [];
    for (const event of body.events ?? []) {
        for (const raw of event.markets ?? []) {
            const market = parseMarket(raw);
            if (market) markets.push(market);
            if (markets.length === MAX_RESULTS) return markets;
        }
    }
    return markets;
}