import { getPlayer, placePick, upsertMarket } from "./db.js";
import { getMarket } from "./polymarket.js";

type Pending = {
  leagueId: number;
  leagueName: string;
  marketId: string;
  tokenId: string | null;
  question: string;
  outcome: string;
  price: number;
  stake: number;
  expires: number;
};

const PENDING_TTL_MS = 5 * 60_000;

// A pick is only saved when the player's next text confirms it, and that check
// lives in code (commands.ts). The model can propose but never confirm.
const pending = new Map<number, Pending>();

export const hasPending = (userId: number) => {
  const p = pending.get(userId);
  if (p && p.expires < Date.now()) pending.delete(userId);
  return pending.has(userId);
};

export const clearPending = (userId: number) => void pending.delete(userId);

export const pct = (price: number) => `${Math.round(price * 100)}%`;
export const money0 = (n: number) =>
  `$${Math.round(n).toLocaleString("en-US")}`;

export type ProposeResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

// Always fetches a fresh price, which also covers the stale-price rule.
export async function proposePick(
  userId: number,
  marketId: string,
  outcomeInput: string,
  stakeInput: number,
): Promise<ProposeResult> {
  const player = getPlayer(userId);
  if (!player.league) return { ok: false, error: "join or create a league first" };

  const stake = Math.round(stakeInput * 100) / 100;
  if (!Number.isFinite(stake) || stake <= 0) {
    return { ok: false, error: "stake must be more than $0" };
  }
  if (stake > player.league.cash) {
    return {
      ok: false,
      error: `not enough cash, you have $${player.league.cash.toFixed(2)}. Try a smaller stake`,
    };
  }

  let market;
  try {
    market = await getMarket(marketId);
  } catch (err) {
    console.error("propose_pick price fetch failed:", err);
    return { ok: false, error: "Polymarket isn't responding, so I can't confirm a price" };
  }
  if (!market) {
    return { ok: false, error: "that market is closed or too thin to bet on. Search for another" };
  }
  upsertMarket(market);

  const idx = market.outcomes.findIndex(
    (o) => o.toLowerCase() === outcomeInput.trim().toLowerCase(),
  );
  const price = market.prices[idx];
  if (idx < 0 || price === undefined) {
    return { ok: false, error: `outcome must be one of: ${market.outcomes.join(", ")}` };
  }
  if (price <= 0 || price >= 1) {
    return { ok: false, error: "that outcome is effectively settled, pick another" };
  }

  const outcome = market.outcomes[idx]!;
  pending.set(userId, {
    leagueId: player.league.id,
    leagueName: player.league.name,
    marketId: market.id,
    tokenId: market.tokenIds[idx] ?? null,
    question: market.question,
    outcome,
    price,
    stake,
    expires: Date.now() + PENDING_TTL_MS,
  });
  return {
    ok: true,
    message: `${market.question}\n${outcome} at ${pct(price)}, $${stake.toFixed(0)} stake. Send yes to lock it in.`,
  };
}

export function confirmPick(userId: number): string {
  const p = pending.get(userId);
  pending.delete(userId);
  if (!p || p.expires < Date.now()) return "That pick expired. Send it again?";

  const r = placePick({
    userId,
    leagueId: p.leagueId,
    marketId: p.marketId,
    tokenId: p.tokenId,
    question: p.question,
    outcome: p.outcome,
    stake: p.stake,
    price: p.price,
  });
  if (!r.ok) return `Couldn't place it: ${r.error}.`;
  return `Locked in: $${p.stake.toFixed(0)} on ${p.outcome} at ${pct(p.price)}. ${money0(r.cash)} cash left.`;
}
