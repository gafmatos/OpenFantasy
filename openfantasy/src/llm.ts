import { getRecentMessages, upsertMarket } from "./db.js";
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
- If nothing matches, say so and suggest different keywords.`;

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

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_markets",
      description:
        "Search open Polymarket markets by keywords. Returns up to 3 markets with outcomes and current prices.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Two or three plain keywords, e.g. 'fed rate cut'",
          },
        },
        required: ["query"],
      },
    },
  },
];

async function runTool(call: ToolCall): Promise<string> {
  let args: { query?: unknown };
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return JSON.stringify({ error: "arguments were not valid JSON" });
  }

  if (call.function.name !== "search_markets") {
    return JSON.stringify({ error: `unknown tool ${call.function.name}` });
  }
  if (typeof args.query !== "string" || !args.query.trim()) {
    return JSON.stringify({ error: "query must be a non-empty string" });
  }

  try {
    const markets = await searchMarkets(args.query);
    for (const m of markets) upsertMarket(m);
    return JSON.stringify(
      markets.map((m) => ({
        market_id: m.id,
        question: m.question,
        outcomes: m.outcomes,
        prices: m.prices,
      })),
    );
  } catch (err) {
    console.error("search_markets failed:", err);
    return JSON.stringify({ error: "Polymarket is unreachable right now" });
  }
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
    { role: "system", content: SYSTEM_PROMPT },
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
        content: await runTool(call),
      });
    }
  }

  return "I couldn't finish that one. Mind trying again?";
}
