import {
  createLeague,
  findMemberLeague,
  getLeaderboard,
  getHistory,
  getLeagueMemberNames,
  getPlayer,
  getPortfolio,
  joinLeague,
  openMarketIds,
  setName,
  upsertMarket,
} from "./db.js";
import { clearPending, confirmPick, hasPending, money0, pct, proposePick } from "./picks.js";
import { getMarket, searchMarkets, topMarkets, type Market } from "./polymarket.js";

const COMMAND = /^\/?(create|join)\s+(.+)$/i;

// A new player who opens with "join CODE" is asked for a name first. Their
// command waits here so they do not have to send it twice.
const pendingCommand = new Map<number, string>();

// The numbered list from the player's last `mkt`, so `bet 1 ...` can refer to it.
const lastList = new Map<number, Market[]>();

// A blank line between commands keeps the list readable in a text thread.
const HELP = [
  "Here's what I understand:",
  "mkt <keywords> - find open markets, like: mkt fed rate cut",
  "bet <#> <yes/no> <$> - bet play money on a market from your last list, like: bet 1 yes 200",
  "portfolio - your cash and open picks",
  "history - your wins, losses and net profit",
  "leaderboard [league] - how everyone in your league ranks",
  "create <name> - start a new league",
  "join <code> - join a friend's league",
].join("\n\n");

function runLeagueCommand(userId: number, verb: string, arg: string): string {
  const player = getPlayer(userId);
  if (player.league) {
    return `You're already in ${player.league.name}. One league at a time for now.`;
  }

  if (verb === "create") {
    const r = createLeague(userId, arg.slice(0, 40));
    if (!r.ok) return r.error;
    return `${r.name} is live with $${r.cash.toFixed(0)} each. Tell friends to text me: join ${r.joinCode}`;
  }

  const r = joinLeague(userId, arg);
  if (!r.ok) return "No league has that code. Double-check it?";
  const others = getLeagueMemberNames(r.leagueId).length - 1;
  return `You're in ${r.name} with $${r.cash.toFixed(0)}, along with ${others} other${others === 1 ? "" : "s"}. Want to find a market to bet on?`;
}

function marketLine(i: number, m: Market): string {
  const prices = m.outcomes.map((o, j) => `${o} ${pct(m.prices[j] ?? 0)}`);
  return `${i + 1}) ${m.question} ${prices.join(" / ")}`;
}

async function runMkt(userId: number, query: string): Promise<string> {
  let markets: Market[];
  try {
    markets = query ? await searchMarkets(query) : await topMarkets();
  } catch (err) {
    console.error("mkt failed:", err);
    return "Polymarket isn't responding right now, so I won't guess. Try again in a minute?";
  }
  if (markets.length === 0) {
    return query
      ? "Nothing open matched that. Try different keywords?"
      : "Couldn't find active markets right now. Try mkt <keywords>?";
  }
  for (const m of markets) upsertMarket(m);
  lastList.set(userId, markets);
  const lines = markets.map((m, i) => marketLine(i, m));
  lines.push("To bet: bet 1 yes 200 (market, outcome, $)");
  return lines.join("\n");
}

async function runBet(userId: number, args: string): Promise<string> {
  const usage = "Format: bet <#> <outcome> <$>, like: bet 1 yes 200";
  const t = args.split(/\s+/).filter(Boolean);
  if (t.length < 3) return usage;

  const stake = Number(t[t.length - 1]!.replace("$", ""));
  const index = Number(t[0]);
  const outcome = t.slice(1, -1).join(" ");
  if (!Number.isInteger(index) || Number.isNaN(stake)) {
    return usage;
  }

  const market = lastList.get(userId)?.[index - 1];
  if (!market) return "I don't have that market. Send mkt <keywords> first, then pick a number.";

  const r = await proposePick(userId, market.id, outcome, stake);
  return r.ok ? r.message : `Can't do that: ${r.error}.`;
}

// Prices for the league's open picks. Falls back to the cache if Polymarket is down.
async function refreshLeaguePrices(leagueId: number): Promise<boolean> {
  const results = await Promise.allSettled(
    openMarketIds(leagueId).map(async (id) => {
      const m = await getMarket(id);
      if (m) upsertMarket(m);
    }),
  );
  return results.every((r) => r.status === "fulfilled");
}

const STALE = " (Polymarket isn't responding, prices may be a bit old)";

async function runLeaderboard(userId: number, leagueName: string): Promise<string> {
  const player = getPlayer(userId);
  if (!player.league) return "Join or create a league first.";

  let league: { id: number; name: string } = player.league;
  if (leagueName) {
    const found = findMemberLeague(userId, leagueName);
    if (!found) return `You're not in a league called ${leagueName}.`;
    league = found;
  }

  const fresh = await refreshLeaguePrices(league.id);
  const rows = getLeaderboard(league.id).map((s, i) => {
    const sign = s.pct >= 0 ? "+" : "";
    return `${i + 1}. ${s.name} ${money0(s.total)} (${money0(s.cash)} cash, ${money0(s.inPlay)} in play), ${sign}${s.pct.toFixed(1)}%`;
  });
  const title = leagueName ? `${league.name}\n` : "";
  return title + rows.join("\n") + (fresh ? "" : STALE);
}

async function runPortfolio(userId: number): Promise<string> {
  const player = getPlayer(userId);
  if (!player.league) return "Join or create a league first.";
  const fresh = await refreshLeaguePrices(player.league.id);
  const { cash, positions } = getPortfolio(userId, player.league.id);
  if (positions.length === 0) return `${money0(cash)} cash and no open picks yet. Try mkt <keywords>.`;
  const lines = positions.map(
    (p) => `${p.outcome} on ${p.question}: ${money0(p.stake)} in, worth ${money0(p.value)} (${pct(p.price)})`,
  );
  return `${money0(cash)} cash.\n${lines.join("\n")}${fresh ? "" : STALE}`;
}

const signed = (n: number) => `${n >= 0 ? "+" : "-"}${money0(Math.abs(n))}`;

function runHistory(userId: number): string {
  const player = getPlayer(userId);
  if (!player.league) return "Join or create a league first.";
  const rows = getHistory(userId, player.league.id);
  if (rows.length === 0) return "No settled picks yet. Your open ones show in portfolio.";
  const wins = rows.filter((r) => r.won).length;
  const net = rows.reduce((sum, r) => sum + r.payout - r.stake, 0);
  const lines = rows
    .slice(0, 5)
    .map((r) => `${r.won ? "W" : "L"} ${r.question} ${r.outcome}, ${signed(r.payout - r.stake)}`);
  return `Record: ${wins}-${rows.length - wins}, net ${signed(net)}.\n${lines.join("\n")}`;
}

// Exact-word commands handled before the LLM: faster, and one less failure
// mode in the demo. Returns the reply, or null to fall through to the LLM.
export async function handleCommand(userId: number, text: string): Promise<string | null> {
  const player = getPlayer(userId);
  const trimmed = text.trim();

  // The reply to "what should I call you?" is the name, then the saved command runs.
  const queued = pendingCommand.get(userId);
  if (queued && !player.name && trimmed) {
    pendingCommand.delete(userId);
    const name = trimmed.slice(0, 40);
    setName(userId, name);
    const m = queued.match(COMMAND);
    const result = m
      ? runLeagueCommand(userId, (m[1] ?? "").toLowerCase(), (m[2] ?? "").trim())
      : "";
    return `Good to meet you, ${name}. ${result}`.trim();
  }

  // A proposed pick is confirmed here, in code. Any other text cancels it.
  if (hasPending(userId)) {
    if (/^(yes|y|yep|yeah|confirm|do it)$/i.test(trimmed)) return confirmPick(userId);
    clearPending(userId);
    if (/^(no|n|nope|cancel)$/i.test(trimmed)) return "Cancelled. Nothing was spent.";
  }

  const word = trimmed.match(/^\/?(\w+)\s*(.*)$/s);
  const verb = (word?.[1] ?? "").toLowerCase();
  const rest = (word?.[2] ?? "").trim();

  switch (verb) {
    case "create":
    case "join":
      if (!rest) return `Format: ${verb} ${verb === "join" ? "<code>" : "<league name>"}`;
      if (!player.name) {
        pendingCommand.set(userId, trimmed);
        return "First things first: what should I call you?";
      }
      return runLeagueCommand(userId, verb, rest);
    case "mkt":
    case "markets":
      return runMkt(userId, rest);
    case "bet":
      return runBet(userId, rest);
    case "leaderboard":
    case "lb":
      return runLeaderboard(userId, rest);
    case "portfolio":
    case "pf":
      return rest ? null : runPortfolio(userId);
    case "history":
    case "record":
      return rest ? null : runHistory(userId);
    case "help":
      return rest ? null : HELP;
  }
  return trimmed.startsWith("/") ? HELP : null;
}
