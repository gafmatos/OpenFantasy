import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { localIMessage } from "@spectrum-ts/imessage-local";
import { getOrCreateUserId, logMessage } from "./db.js";
import { handleCommand } from "./commands.js";
import { runAgent } from "./llm.js";
import { settleAndNotify, startSettlementLoop } from "./settle.js";
// Spectrum bridges a single agent loop to many messaging interfaces.
// Each provider in `providers` adds an interface (terminal TUI, iMessage, …).
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [
    // IMESSAGE_MODE=local reads this Mac's Messages app instead of the Photon cloud line
    imessage.config(),
  ],
});

// Messages a player first (settlement results). Players are routed by phone number.
// The provider is a runtime choice, which the types cannot see. Both platforms
// expose the same user() / space.create() calls when given the app.
type Dm = { send(text: string): Promise<unknown> };
type PlatformApi = {
  user(phone: string): Promise<unknown>;
  space: { create(user: unknown): Promise<Dm> };
};
const platform = (process.env.IMESSAGE_MODE === "local" ? localIMessage : imessage) as unknown as (
  app: unknown,
) => PlatformApi;
async function notify(phone: string, text: string): Promise<void> {
  const im = platform(app);
  const user = await im.user(phone);
  const dm = await im.space.create(user);
  await dm.send(text);
}
startSettlementLoop(notify);

// SIMULATED settlement for the demo: ADMIN_PHONE texts "resolve <marketId> <outcome>".
const ADMIN_RESOLVE = /^resolve\s+(\S+)\s+(.+)$/i;

// `app.messages` is an async iterable. Each tick yields a `space` (the
// conversation) and an inbound `message`. Reply by awaiting `space.send(...)`.
for await (const [space, message] of app.messages) {
  console.log(
    "inbound:",
    message.sender?.id,
    message.content.type,
    message.content.type === "text" ? message.content.text.slice(0, 40) : "",
  );
  if (message.content.type !== "text") continue;
  const phone = message.sender?.id;
  if (!phone) continue;

  const userId = getOrCreateUserId(phone);
  const text = message.content.text;

  const adminMatch = text.trim().match(ADMIN_RESOLVE);
  if (adminMatch && process.env.ADMIN_PHONE && phone === process.env.ADMIN_PHONE) {
    const n = await settleAndNotify(adminMatch[1]!, adminMatch[2]!.trim(), notify);
    await space.send(`Simulated resolve: settled ${n} pick${n === 1 ? "" : "s"}.`);
    continue;
  }

  // Run the agent before logging the inbound text: runAgent loads history
  // from the table and appends `text` itself, so logging first would duplicate it.
  let reply: string;
  try {
    reply =
      (await handleCommand(userId, text)) ??
      (await space.responding(() => runAgent(userId, text)));
  } catch (err) {
    console.error("agent failed:", err);
    reply = "Hit a snag on my end. Try again in a sec?";
  }

  logMessage(userId, "user", text);
  try {
    await space.send(reply);
  } catch (err) {
    console.error("send failed:", err);
    continue;
  }
  logMessage(userId, "assistant", reply);
}
