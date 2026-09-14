// BotHost entry point.
// The actual bot lives in bothost-bot/ and uses that folder's ES module settings.
import("./bothost-bot/index.js").catch((error) => {
  console.error("RadarMap Telegram bot failed to start:", error);
  process.exitCode = 1;
});