import { allOpenMarketIds, settleMarket, type Settled } from "./db.js";
import { getResolution } from "./polymarket.js";
import { money0 } from "./picks.js";

const INTERVAL_MS = 60_000;

export function settlementText(s: Settled): string {
  return s.won
    ? `You won! "${s.question}" resolved ${s.outcome}. +${money0(s.payout)} payout, ${money0(s.cash)} cash now.`
    : `Tough one: "${s.question}" didn't go ${s.outcome}. You lost ${money0(s.stake)}, ${money0(s.cash)} cash left.`;
}

// Settles one market and texts each player. Also used by the simulated `resolve` admin command.
export async function settleAndNotify(
  marketId: string,
  winningOutcome: string,
  notify: (phone: string, text: string) => Promise<void>,
): Promise<number> {
  const settled = settleMarket(marketId, winningOutcome);
  for (const s of settled) {
    try {
      await notify(s.phone, settlementText(s));
    } catch (err) {
      console.error("settlement notify failed:", err);
    }
  }
  return settled.length;
}

export function startSettlementLoop(notify: (phone: string, text: string) => Promise<void>) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const id of allOpenMarketIds()) {
        try {
          const r = await getResolution(id);
          if (r.resolved) await settleAndNotify(id, r.winningOutcome, notify);
        } catch (err) {
          console.error(`settlement check failed for ${id}:`, err);
        }
      }
    } finally {
      running = false;
    }
  }, INTERVAL_MS);
}
