import { getOrCreateUser, saveQA, getHistory } from "./db";

async function main() {
  // Create (or fetch) a test user
  const user = await getOrCreateUser("+15555550123", "Test User");
  console.log("User:", user);

  // Save a sample question and answer
  await saveQA(user.id, "Will it rain tomorrow?", "60% chance of yes", "test-market");
  console.log("Saved Q&A");

  // Read back the history
  const history = await getHistory(user.id);
  console.log("History:", history);
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});