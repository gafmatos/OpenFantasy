import Database from "better-sqlite3";
import type { Market } from "./polymarket.js";

// May remove process.env.path, currently only relying on the local
export const db = new Database(process.env.DB_PATH ?? "openfantasy.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY,
  phone            TEXT NOT NULL UNIQUE,
  name             TEXT,
  active_league_id INTEGER
);

CREATE TABLE IF NOT EXISTS leagues (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  join_code     TEXT NOT NULL UNIQUE,
  starting_cash REAL NOT NULL DEFAULT 1000,
  created_by    INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id   INTEGER NOT NULL REFERENCES users(id),
  league_id INTEGER NOT NULL REFERENCES leagues(id),
  cash      REAL NOT NULL,
  PRIMARY KEY (user_id, league_id)
);

CREATE TABLE IF NOT EXISTS picks (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  league_id     INTEGER NOT NULL REFERENCES leagues(id),
  market_id     TEXT NOT NULL,
  token_id      TEXT,
  question      TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  stake         REAL NOT NULL,
  shares        REAL NOT NULL,
  entry_price   REAL NOT NULL,
  confidence    INTEGER,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  payout        REAL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS markets (
  market_id       TEXT PRIMARY KEY,
  question        TEXT NOT NULL,
  outcomes        TEXT NOT NULL,
  last_prices     TEXT NOT NULL,
  resolved        INTEGER NOT NULL DEFAULT 0,
  winning_outcome TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  market_id     TEXT NOT NULL,
  last_fired_at TEXT NOT NULL,
  PRIMARY KEY (user_id, market_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
CREATE INDEX IF NOT EXISTS idx_picks_open ON picks(league_id, status);
`);




const upsertUser = db.prepare(
  "INSERT INTO users (phone) VALUES (?) ON CONFLICT(phone) DO NOTHING",
);

// selects id where phone equals the parameter from selectUser.get(<parameter>);
const selectUser = db.prepare("SELECT id FROM users WHERE phone = ?");
const insertMessage = db.prepare(
  "INSERT INTO messages (user_id, role, text) VALUES (?, ?, ?)",
);

const upsertMarketStmt = db.prepare(`
  INSERT INTO markets (market_id, question, outcomes, last_prices, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(market_id) DO UPDATE SET
    question    = excluded.question,
    outcomes    = excluded.outcomes,
    last_prices = excluded.last_prices,
    updated_at  = excluded.updated_at
`);

export function upsertMarket(market: Market): void {
  upsertMarketStmt.run(
    market.id,
    market.question,
    JSON.stringify(market.outcomes),
    JSON.stringify(market.prices),
  );
}

const selectRecent = db.prepare(
  "SELECT role, text FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?",
);

// Oldest first, ready to send to the LLM.
export function getRecentMessages(
  userId: number,
  limit: number,
): { role: "user" | "assistant"; text: string }[] {
  const rows = selectRecent.all(userId, limit) as {
    role: "user" | "assistant";
    text: string;
  }[];
  return rows.reverse();
}

export function getOrCreateUserId(phone: string): number {
  upsertUser.run(phone);
  return (selectUser.get(phone) as { id: number }).id;
}

export type Player = {
  name: string | null;
  league: { id: number; name: string; joinCode: string; cash: number } | null;
};

const selectPlayer = db.prepare(`
  SELECT u.name AS name, l.id AS leagueId, l.name AS leagueName,
         l.join_code AS joinCode, m.cash AS cash
  FROM users u
  LEFT JOIN leagues l ON l.id = u.active_league_id
  LEFT JOIN memberships m ON m.user_id = u.id AND m.league_id = l.id
  WHERE u.id = ?
`);

export function getPlayer(userId: number): Player {
  const r = selectPlayer.get(userId) as {
    name: string | null;
    leagueId: number | null;
    leagueName: string | null;
    joinCode: string | null;
    cash: number | null;
  };
  return {
    name: r.name,
    league:
      r.leagueId === null
        ? null
        : {
            id: r.leagueId,
            name: r.leagueName!,
            joinCode: r.joinCode!,
            cash: r.cash!,
          },
  };
}

export function setName(userId: number, name: string): void {
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, userId);
}

// No 0/O/1/I so codes survive being read aloud or retyped.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export type LeagueResult =
  | { ok: true; leagueId: number; name: string; joinCode: string; cash: number }
  | { ok: false; error: string };

const STARTING_CASH = 1000;

export const createLeague = db.transaction(
  (userId: number, name: string): LeagueResult => {
    let joinCode = randomCode();
    while (db.prepare("SELECT 1 FROM leagues WHERE join_code = ?").get(joinCode)) {
      joinCode = randomCode();
    }
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO leagues (name, join_code, starting_cash, created_by) VALUES (?, ?, ?, ?)",
      )
      .run(name, joinCode, STARTING_CASH, userId);
    const leagueId = Number(lastInsertRowid);
    db.prepare(
      "INSERT INTO memberships (user_id, league_id, cash) VALUES (?, ?, ?)",
    ).run(userId, leagueId, STARTING_CASH);
    db.prepare("UPDATE users SET active_league_id = ? WHERE id = ?").run(
      leagueId,
      userId,
    );
    return { ok: true, leagueId, name, joinCode, cash: STARTING_CASH };
  },
);

export const joinLeague = db.transaction(
  (userId: number, code: string): LeagueResult => {
    const league = db
      .prepare(
        "SELECT id, name, join_code, starting_cash FROM leagues WHERE join_code = ?",
      )
      .get(code.trim().toUpperCase()) as
      | { id: number; name: string; join_code: string; starting_cash: number }
      | undefined;
    if (!league) return { ok: false, error: "no league has that code" };

    const existing = db
      .prepare("SELECT 1 FROM memberships WHERE user_id = ? AND league_id = ?")
      .get(userId, league.id);
    if (existing) return { ok: false, error: "already in that league" };

    db.prepare(
      "INSERT INTO memberships (user_id, league_id, cash) VALUES (?, ?, ?)",
    ).run(userId, league.id, league.starting_cash);
    db.prepare("UPDATE users SET active_league_id = ? WHERE id = ?").run(
      league.id,
      userId,
    );
    return {
      ok: true,
      leagueId: league.id,
      name: league.name,
      joinCode: league.join_code,
      cash: league.starting_cash,
    };
  },
);

export type PlaceResult =
  | { ok: true; shares: number; cash: number }
  | { ok: false; error: string };

// One transaction: check cash, deduct the stake, insert the pick. better-sqlite3
// runs it synchronously, so two quick texts cannot spend the same money.
export const placePick = db.transaction(
  (p: {
    userId: number;
    leagueId: number;
    marketId: string;
    tokenId: string | null;
    question: string;
    outcome: string;
    stake: number;
    price: number;
  }): PlaceResult => {
    const m = db
      .prepare("SELECT cash FROM memberships WHERE user_id = ? AND league_id = ?")
      .get(p.userId, p.leagueId) as { cash: number } | undefined;
    if (!m) return { ok: false, error: "you're not in that league" };
    if (m.cash < p.stake) {
      return { ok: false, error: `not enough cash, you have $${m.cash.toFixed(2)}` };
    }
    const shares = p.stake / p.price;
    const cash = m.cash - p.stake;
    db.prepare(
      "UPDATE memberships SET cash = ? WHERE user_id = ? AND league_id = ?",
    ).run(cash, p.userId, p.leagueId);
    db.prepare(
      `INSERT INTO picks (user_id, league_id, market_id, token_id, question, outcome,
                          stake, shares, entry_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.userId, p.leagueId, p.marketId, p.tokenId, p.question, p.outcome,
      p.stake, shares, p.price,
    );
    return { ok: true, shares, cash };
  },
);

export type Position = {
  userId: number;
  question: string;
  outcome: string;
  stake: number;
  shares: number;
  price: number; // current cached price, or entry price if the market is not cached
  value: number;
};

function loadPositions(leagueId: number, userId?: number): Position[] {
  const rows = db
    .prepare(
      `SELECT p.user_id, p.question, p.outcome, p.stake, p.shares, p.entry_price,
              m.outcomes, m.last_prices
       FROM picks p LEFT JOIN markets m ON m.market_id = p.market_id
       WHERE p.league_id = ? AND p.status = 'open' AND (? IS NULL OR p.user_id = ?)
       ORDER BY p.id`,
    )
    .all(leagueId, userId ?? null, userId ?? null) as {
    user_id: number;
    question: string;
    outcome: string;
    stake: number;
    shares: number;
    entry_price: number;
    outcomes: string | null;
    last_prices: string | null;
  }[];

  return rows.map((r) => {
    let price = r.entry_price;
    if (r.outcomes && r.last_prices) {
      const i = (JSON.parse(r.outcomes) as string[]).indexOf(r.outcome);
      const cached = (JSON.parse(r.last_prices) as number[])[i];
      if (i >= 0 && typeof cached === "number") price = cached;
    }
    return {
      userId: r.user_id,
      question: r.question,
      outcome: r.outcome,
      stake: r.stake,
      shares: r.shares,
      price,
      value: r.shares * price,
    };
  });
}

export function getPortfolio(userId: number, leagueId: number) {
  const row = db
    .prepare("SELECT cash FROM memberships WHERE user_id = ? AND league_id = ?")
    .get(userId, leagueId) as { cash: number } | undefined;
  return { cash: row?.cash ?? 0, positions: loadPositions(leagueId, userId) };
}

export type Standing = {
  name: string;
  cash: number;
  inPlay: number;
  total: number;
  pct: number;
};

// Computed on every call, never stored. Prices come from the `markets` cache,
// so refresh it first when freshness matters.
export function getLeaderboard(leagueId: number): Standing[] {
  const league = db
    .prepare("SELECT starting_cash FROM leagues WHERE id = ?")
    .get(leagueId) as { starting_cash: number } | undefined;
  if (!league) return [];
  const members = db
    .prepare(
      `SELECT m.user_id, COALESCE(u.name, 'Someone') AS name, m.cash
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.league_id = ?`,
    )
    .all(leagueId) as { user_id: number; name: string; cash: number }[];

  const inPlay = new Map<number, number>();
  for (const p of loadPositions(leagueId)) {
    inPlay.set(p.userId, (inPlay.get(p.userId) ?? 0) + p.value);
  }
  return members
    .map((m) => {
      const play = inPlay.get(m.user_id) ?? 0;
      const total = m.cash + play;
      return {
        name: m.name,
        cash: m.cash,
        inPlay: play,
        total,
        pct: ((total - league.starting_cash) / league.starting_cash) * 100,
      };
    })
    .sort((a, b) => b.total - a.total);
}

// Only leagues the player belongs to, so one league cannot read another's data
// by guessing its name. Prefers the active league if two share a name.
export function findMemberLeague(
  userId: number,
  name: string,
): { id: number; name: string } | null {
  const row = db
    .prepare(
      `SELECT l.id, l.name
       FROM memberships m
       JOIN leagues l ON l.id = m.league_id
       LEFT JOIN users u ON u.id = m.user_id AND u.active_league_id = l.id
       WHERE m.user_id = ? AND lower(l.name) = lower(?)
       ORDER BY u.id IS NULL
       LIMIT 1`,
    )
    .get(userId, name.trim()) as { id: number; name: string } | undefined;
  return row ?? null;
}

export type Settled = {
  userId: number;
  phone: string;
  question: string;
  outcome: string;
  stake: number;
  payout: number;
  won: boolean;
  cash: number;
};

// One transaction. Only 'open' picks are touched, so running it twice for the
// same market pays nobody twice. Winners get shares x $1; losers get nothing.
export const settleMarket = db.transaction(
  (marketId: string, winningOutcome: string): Settled[] => {
    const picks = db
      .prepare(
        `SELECT p.id, p.user_id, p.league_id, p.question, p.outcome, p.stake, p.shares, u.phone
         FROM picks p JOIN users u ON u.id = p.user_id
         WHERE p.market_id = ? AND p.status = 'open'`,
      )
      .all(marketId) as {
      id: number;
      user_id: number;
      league_id: number;
      question: string;
      outcome: string;
      stake: number;
      shares: number;
      phone: string;
    }[];

    const settled: Settled[] = [];
    for (const p of picks) {
      const won = p.outcome === winningOutcome;
      const payout = won ? p.shares : 0;
      db.prepare("UPDATE picks SET status = ?, payout = ? WHERE id = ?").run(
        won ? "won" : "lost",
        payout,
        p.id,
      );
      db.prepare(
        "UPDATE memberships SET cash = cash + ? WHERE user_id = ? AND league_id = ?",
      ).run(payout, p.user_id, p.league_id);
      const m = db
        .prepare("SELECT cash FROM memberships WHERE user_id = ? AND league_id = ?")
        .get(p.user_id, p.league_id) as { cash: number };
      settled.push({
        userId: p.user_id,
        phone: p.phone,
        question: p.question,
        outcome: p.outcome,
        stake: p.stake,
        payout,
        won,
        cash: m.cash,
      });
    }
    db.prepare(
      "UPDATE markets SET resolved = 1, winning_outcome = ? WHERE market_id = ?",
    ).run(winningOutcome, marketId);
    return settled;
  },
);

export type HistoryRow = {
  question: string;
  outcome: string;
  stake: number;
  payout: number;
  won: boolean;
};

// Settled picks for one player in one league, newest first.
export function getHistory(userId: number, leagueId: number): HistoryRow[] {
  const rows = db
    .prepare(
      `SELECT question, outcome, stake, COALESCE(payout, 0) AS payout, status
       FROM picks
       WHERE user_id = ? AND league_id = ? AND status IN ('won', 'lost')
       ORDER BY id DESC`,
    )
    .all(userId, leagueId) as (Omit<HistoryRow, "won"> & { status: string })[];
  return rows.map((r) => ({ ...r, won: r.status === "won" }));
}

export function allOpenMarketIds(): string[] {
  const rows = db
    .prepare("SELECT DISTINCT market_id FROM picks WHERE status = 'open'")
    .all() as { market_id: string }[];
  return rows.map((r) => r.market_id);
}

export function openMarketIds(leagueId: number): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT market_id FROM picks WHERE league_id = ? AND status = 'open'",
    )
    .all(leagueId) as { market_id: string }[];
  return rows.map((r) => r.market_id);
}

// Display names only. Phone numbers never leave the server.
export function getLeagueMemberNames(leagueId: number): string[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(u.name, 'Someone') AS name
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.league_id = ? ORDER BY u.id`,
    )
    .all(leagueId) as { name: string }[];
  return rows.map((r) => r.name);
}

export function logMessage(
  userId: number,
  role: "user" | "assistant",
  text: string,
): void {
  insertMessage.run(userId, role, text);
}
