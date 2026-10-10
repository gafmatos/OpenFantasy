import Database from "better-sqlite3";
import type { Market } from "./polymarket.js";

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

export function logMessage(
  userId: number,
  role: "user" | "assistant",
  text: string,
): void {
  insertMessage.run(userId, role, text);
}
