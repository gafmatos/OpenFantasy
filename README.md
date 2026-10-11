# iMessage Polymarket Fantasy Agent

OpenFantasy is a fantasy league for predicting real events, played entirely over iMessage. Friends text one AI agent, bet play money on real Polymarket questions at live odds, and the agent keeps score.

Built for HackNC 2026, track "Best iMessage Agent with Photon", on [Spectrum](https://photon.codes/docs/spectrum-ts).

**Play money only.** There is no real trading, wallet or Polymarket login. Prices are read from Polymarket's public API.

## What is it?

You text the agent like a friend who follows the markets. You find a question ("Will the Fed cut rates by December?"), bet pretend dollars on an outcome at the live price, and watch a leaderboard against your friends. When the market resolves, winners are paid and everyone gets a text.

Everyone starts a league with $1,000. A price is a probability: 62¢ means a 62% chance, and each share pays $1 if it comes true and $0 if not. Players are ranked by total value: cash plus open picks at current prices.

## How does it work?

**What a player can text**

| Text | What happens |
| --- | --- |
| `create <name>` | Start a league and get a join code |
| `join <code>` | Join a friend's league |
| `mkt <keywords>` | Up to 3 open markets with live prices |
| `bet <#> <yes/no> <$>` | Propose a pick from your last market list; reply `yes` to lock it in |
| `portfolio` | Cash and open picks at current value |
| `history` | Win-loss record, net profit and recent settled picks |
| `leaderboard [league]` | League ranking with cash, money in play and % return |
| `help` | The list above |

Anything else (for example "what are the odds the Fed cuts rates?") goes to the LLM, which can search markets, set your name, create or join a league, and propose a pick.

**One process, one database file.** Each text goes through the same path:

1. Spectrum delivers the message and the sender's phone number.
2. Exact-word commands (`leaderboard`, `portfolio`, `bet`, ...) are handled in code. Everything else goes to the LLM with the player's last 10 messages.
3. The LLM calls tools; the server fills in the user and league from the phone number, never from the model.
4. The reply is sent back as a text.

**Settlement.** Every 60 seconds the app checks each market that has open picks. A market counts as resolved only when Polymarket says it is closed and resolved, and exactly one outcome is priced at $1. Winners get `shares x $1` added to cash, losers get nothing, and each player gets a text with the result. Settlement is one database transaction and only touches open picks, so a market can never pay twice.

**Rules the code enforces**
- The LLM talks, code counts. All money, share and ranking arithmetic is plain TypeScript; the LLM never invents a price.
- The LLM never chooses the user or the league.
- A pick is saved only after the player replies `yes`, checked in code. Cash is checked and deducted in one transaction, so two quick texts cannot spend the same money.
- Polymarket search results are filtered: closed markets and thin markets (spread above 0.10) are skipped. If Polymarket is unreachable the agent says so instead of guessing.
- Phone numbers are used only for routing. Other players only ever see display names.

**Stack:** TypeScript on Node with `tsx`, `spectrum-ts` (iMessage), SQLite via `better-sqlite3`, Google Gemini for the LLM (through its OpenAI-compatible endpoint), and the Polymarket Gamma API for markets.

Code lives in `openfantasy/src`: `index.ts` (message loop), `commands.ts` (keyword commands), `llm.ts` (tool loop), `picks.ts` (propose and confirm), `polymarket.ts` (market data and resolution), `settle.ts` (settlement loop), `db.ts` (schema and queries).

### Run it

```sh
cd openfantasy
npm install
# create .env with the variables below
npm run start
```

`.env` is never committed:

| Variable | Purpose |
| --- | --- |
| `PROJECT_ID`, `PROJECT_SECRET` | Photon project credentials from the [Photon dashboard](https://app.photon.codes) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | LLM access |
| `IMESSAGE_MODE` | Optional. `local` reads and sends through the Messages app on the Mac running the agent instead of Photon's cloud line |
| `ADMIN_PHONE` | Optional. The one phone allowed to run the simulated `resolve` command |
| `DB_PATH` | Optional. Database file, default `openfantasy.db` |

**Two ways to receive texts**
- **Photon cloud (default).** Players text the line Photon assigns them. On the shared plan each player can get a different number, so check the Photon dashboard.
- **Local (`IMESSAGE_MODE=local`).** The agent runs on a Mac signed into iMessage, and players text that Mac's iMessage address. The terminal needs Full Disk Access, and texts from the Mac's own Apple ID won't count as inbound. We added this when the cloud line stopped delivering during the hackathon.

## Other

**Simulated parts (labelled in the demo).** Real markets will not close during a demo, so the admin phone (`ADMIN_PHONE`) can text `resolve <marketId> <outcome>` to settle a market on demand. This runs the same settlement code as the real loop, but **the outcome is chosen by hand, not by Polymarket**.

**Not built yet**
- Broadcasting each pick to the rest of the league.
- Automatic nudge when a held market's price moves sharply (the `alerts` table exists, nothing uses it yet).
- Calibration scoring, early cash-out, weekly recap, several leagues per player.

**Known limits**
- One league per player, and a fixed $1,000 starting balance.
- Disputed and voided (50/50) markets stay open until they clearly resolve.
- The settlement text to players was tested in code but not yet on a real phone, especially in local mode.
- Market lists and unconfirmed picks are kept in memory, so restarting the app forgets an unconfirmed pick.
