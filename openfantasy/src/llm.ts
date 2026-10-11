import {
  createLeague,
  getPlayer,
  getRecentMessages,
  joinLeague,
  setName,
  upsertMarket,
} from "./db.js";
import { proposePick } from "./picks.js";
import { searchMarkets } from "./polymarket.js";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL;
if (!API_KEY || !MODEL) {
  throw new Error("GEMINI_API_KEY and GEMINI_MODEL must be set in .env");
}

const CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const HISTORY_LIMIT = 10;
const MAX_ITERATIONS = 5;

const SYSTEM_PROMPT = `You are the host of a prediction league played over iMessage. Friends bet play money on real Polymarket questions. You are a friend who follows the markets.

Style: reply in three lines or fewer and ask one question at a time. This is a text message, so no markdown, bullet lists or headings.

Rules:
- When asked about the odds of something, call search_markets with two or three plain keywords, not the whole sentence.
- Never state a price, percentage or number that did not come from a tool result. If a tool reports an error, say Polymarket isn't responding and do not guess.
- Prices are probabilities: 0.62 means a 62% chance. Say it as a percentage.
- If several markets match, show at most three and ask which one the player means.
- If nothing matches, say so and suggest different keywords.
- To place a pick, call propose_pick with the market_id, outcome and stake the player gave. If they have not given a stake, ask for it. When it succeeds, repeat its message and tell them to reply yes to lock it in. You cannot confirm a pick yourself.
- You cannot show a leaderboard or portfolio. Tell the player to text "leaderboard" or "portfolio".
- Commands the player can text: mkt <keywords>, bet <#> <yes/no> <$>, leaderboard, portfolio.`;

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  [extra: string]: unknown; // Gemini adds extra_content.google.thought_signature
};

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

function stringTool(name: string, description: string, param: string, hint: string) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: { [param]: { type: "string", description: hint } },
        required: [param],
      },
    },
  };
}

const TOOLS = [
  stringTool(
    "search_markets",
    "Search open Polymarket markets by keywords. Returns up to 3 markets with outcomes and current prices.",
    "query",
    "Two or three plain keywords, e.g. 'fed rate cut'",
  ),
  stringTool(
    "set_name",
    "Save the player's display name. Call it when the player tells you what to call them.",
    "name",
    "The name as the player gave it",
  ),
  stringTool(
    "create_league",
    "Create a new league with the player as its first member. Returns the join code to share.",
    "name",
    "League name",
  ),
  stringTool(
    "join_league",
    "Join an existing league using its join code.",
    "code",
    "The join code, e.g. HEELS",
  ),
];

TOOLS.push({
  type: "function",
  function: {
    name: "propose_pick",
    description:
      "Propose a pick for the player. Nothing is saved until the player texts yes, which the server handles. Use a market_id from search_markets and an outcome label exactly as listed there.",
    parameters: {
      type: "object",
      properties: {
        market_id: { type: "string", description: "market_id from search_markets" },
        outcome: { type: "string", description: "Outcome label, e.g. Yes" },
        stake: { type: "number", description: "Play-money dollars to stake" },
      },
      required: ["market_id", "outcome", "stake"],
    },
  },
} as (typeof TOOLS)[number]);

// Tools take only what the model may choose. userId comes from the server.
type Handler = (userId: number, value: string) => Promise<unknown> | unknown;

const HANDLERS: Record<string, { param: string; run: Handler }> = {
  search_markets: {
    param: "query",
    run: async (_userId, query) => {
      try {
        const markets = await searchMarkets(query);
        for (const m of markets) upsertMarket(m);
        return markets.map((m) => ({
          market_id: m.id,
          question: m.question,
          outcomes: m.outcomes,
          prices: m.prices,
        }));
      } catch (err) {
        console.error("search_markets failed:", err);
        return { error: "Polymarket is unreachable right now" };
      }
    },
  },
  set_name: {
    param: "name",
    run: (userId, name) => {
      setName(userId, name.slice(0, 40));
      return { ok: true };
    },
  },
  create_league: {
    param: "name",
    run: (userId, name) => createLeague(userId, name.slice(0, 40)),
  },
  join_league: {
    param: "code",
    run: (userId, code) => joinLeague(userId, code),
  },
};

async function runTool(userId: number, call: ToolCall): Promise<string> {
  if (call.function.name === "propose_pick") {
    let a: Record<string, unknown>;
    try {
      a = JSON.parse(call.function.arguments);
    } catch {
      return JSON.stringify({ error: "arguments were not valid JSON" });
    }
    if (typeof a.market_id !== "string" || typeof a.outcome !== "string") {
      return JSON.stringify({ error: "market_id and outcome must be strings" });
    }
    return JSON.stringify(
      await proposePick(userId, a.market_id, a.outcome, Number(a.stake)),
    );
  }

  const handler = HANDLERS[call.function.name];
  if (!handler) {
    return JSON.stringify({ error: `unknown tool ${call.function.name}` });
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return JSON.stringify({ error: "arguments were not valid JSON" });
  }
  const value = args[handler.param];
  if (typeof value !== "string" || !value.trim()) {
    return JSON.stringify({ error: `${handler.param} must be a non-empty string` });
  }
  return JSON.stringify(await handler.run(userId, value.trim()));
}

// Built by the server on every turn so the model knows which onboarding step is next.
function playerContext(userId: number): string {
  const p = getPlayer(userId);
  if (!p.name) {
    return "Player state: no name yet. Ask what to call them, then call set_name.";
  }
  if (!p.league) {
    return `Player state: name is ${p.name}, not in a league. Tell them to text 'create <league name>' to start one or 'join <code>' if a friend sent a code.`;
  }
  return `Player state: name is ${p.name}, in league "${p.league.name}" (join code ${p.league.joinCode}) with $${p.league.cash.toFixed(2)} cash.`;
}

type ChatResponse = {
  choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
};

// Gemini latency is spiky (seen: 2s to 84s) and it sometimes returns 503, so
// retry once on a timeout or 5xx before giving up.
async function callGemini(messages: ChatMessage[]): Promise<ChatResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ model: MODEL, messages, tools: TOOLS }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return (await res.json()) as ChatResponse;
      const detail = `Gemini request failed: ${res.status} ${await res.text()}`;
      if (res.status < 500 || attempt === 2) throw new Error(detail);
      console.error(`${detail} (retrying)`);
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      if (!timedOut || attempt === 2) throw err;
      console.error("Gemini request timed out (retrying)");
    }
  }
}

// `history` is read before the new text is logged, so `text` is not duplicated.
// userId is set by the server and is never a tool parameter.
export async function runAgent(userId: number, text: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\n${playerContext(userId)}` },
    ...getRecentMessages(userId, HISTORY_LIMIT).map(
      (m): ChatMessage => ({ role: m.role, content: m.text }),
    ),
    { role: "user", content: text },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const body = await callGemini(messages);
    const msg = body.choices[0]?.message;
    if (!msg) throw new Error("Gemini returned no choices");

    if (!msg.tool_calls?.length) {
      return msg.content?.trim() || "Not sure what to say to that. Try again?";
    }

    // Send the assistant turn back unmodified so thought signatures survive.
    messages.push({ role: "assistant", ...msg });
    for (const call of msg.tool_calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await runTool(userId, call),
      });
    }
  }

  return "I couldn't finish that one. Mind trying again?";
}
