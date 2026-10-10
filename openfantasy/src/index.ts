import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { getOrCreateUserId, logMessage } from "./db.js";
// Spectrum bridges a single agent loop to many messaging interfaces.
// Each provider in `providers` adds an interface (terminal TUI, iMessage, …).
// Docs: https://photon.codes/docs/spectrum-ts
const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [
    // imessage
    imessage.config(),
  ],
});

// `app.messages` is an async iterable. Each tick yields a `space` (the
// conversation) and an inbound `message`. Reply by awaiting `space.send(...)`.
for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  const phone = message.sender?.id;
  if (!phone) continue;

  const userId = getOrCreateUserId(phone);
  logMessage(userId, "user", message.content.text);

  const reply = `echo: ${message.content.text}`;
  await space.send(reply);
  logMessage(userId, "assistant", reply);
}
