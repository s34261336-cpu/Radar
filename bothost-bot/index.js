import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBSCRIBERS_FILE = path.join(__dirname, "subscribers.json");
const TELEGRAM_API = "https://api.telegram.org";
const RADAR_MAP_API =
  process.env.RADAR_MAP_API_URL?.trim() || "https://radar-map.ru/api/state";
const POLL_INTERVAL_MS = readPositiveNumber(
  process.env.RADAR_MAP_POLL_INTERVAL_MS,
  15_000,
);
const DUPLICATE_WINDOW_MS = readPositiveNumber(
  process.env.RADAR_DUPLICATE_WINDOW_MS,
  30 * 60 * 1000,
);
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const RETRY_DELAY_MS = 5_000;
const SEND_DELAY_MS = 40;
const RADAR_SIGNATURE_PATTERN =
  /\s*📡\s*Локатор России\s*[-–—]\s*@locatorru\s*$/iu;
const DONATION_LINK_PATTERN =
  /(?:https?:\/\/)?(?:www\.)?(?:pay\.)?cloudtips\.ru\b/iu;
const SUPPORT_APPEAL_PATTERN =
  /(?:поддержк\w*|деятельност\w*|донат\w*|пожертвован\w*|помощ\w*)/iu;
const WARM_APPEAL_PATTERN =
  /(?:наши\s+дорогие\s+близкие|спасибо\s+огромн\w*\s+за\s+поддержк\w*|поддержк\w*\s+(?:нашей|нашу|нашего)\s+деятельност\w*)/iu;
const EXTERNAL_LINK_PATTERN = /https?:\/\/\S+/iu;
const HEART_PATTERN = /(?:❤️|❤|♥️|💕|💖|💗|💓|💞|💘)/gu;
const TELEGRAM_COMMANDS = [
  { command: "start", description: "Подписаться на новые сообщения" },
  { command: "stop", description: "Отписаться от рассылки" },
  { command: "help", description: "Показать список команд" },
  { command: "commands", description: "Показать список команд" },
];
const COMMANDS_TEXT =
  "Доступные команды:\n" +
  "/start — подписаться на новые сообщения\n" +
  "/stop — отписаться от рассылки\n" +
  "/help — показать этот список\n" +
  "/commands — показать этот список";

const token =
  process.env.TELEGRAM_BOT_TOKEN?.trim() ||
  process.env.BOT_TOKEN?.trim() ||
  process.env.TELEGRAM_TOKEN?.trim() ||
  process.env.TOKEN?.trim();

if (!token) {
  throw new Error(
    "Bot token is missing. Set TELEGRAM_BOT_TOKEN or BOT_TOKEN in BotHost.",
  );
}

let stopped = false;
let updateOffset = 0;
let knownRadarMessages = new Set();
let radarInitialized = false;

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function radarMessageKey(message) {
  const source = message.source_id || message.channel || "radar-map";
  const id =
    message.msg_id ?? `${message.ts || 0}:${message.text || ""}`;
  return `${source}:${id}`;
}

function removeRadarSignature(text) {
  return text.replace(RADAR_SIGNATURE_PATTERN, "").trim();
}

function isUnwantedPromotionalMessage(text) {
  const cleanedText = removeRadarSignature(text);
  const heartCount = cleanedText.match(HEART_PATTERN)?.length || 0;
  const hasDonationLink = DONATION_LINK_PATTERN.test(cleanedText);
  const hasSupportAppeal =
    SUPPORT_APPEAL_PATTERN.test(cleanedText) ||
    WARM_APPEAL_PATTERN.test(cleanedText);

  return (
    hasDonationLink ||
    (hasSupportAppeal &&
      (EXTERNAL_LINK_PATTERN.test(cleanedText) || heartCount >= 2))
  );
}

function normalizeRadarText(text) {
  return removeRadarSignature(text)
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function areNearDuplicateTexts(left, right) {
  if (left === right) return true;
  if (left.length < 24 || right.length < 24) return false;

  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  const union = new Set([...leftWords, ...rightWords]);
  const intersection = [...leftWords].filter((word) =>
    rightWords.has(word),
  );
  const lengthRatio =
    Math.min(left.length, right.length) / Math.max(left.length, right.length);

  return intersection.length / union.size >= 0.85 && lengthRatio >= 0.75;
}

function isRecentRadarDuplicate(text, recentTexts, now) {
  const normalizedText = normalizeRadarText(text);
  if (!normalizedText) return false;

  for (let index = recentTexts.length - 1; index >= 0; index -= 1) {
    if (now - recentTexts[index].seenAt > DUPLICATE_WINDOW_MS) {
      recentTexts.splice(index, 1);
    }
  }

  return recentTexts.some((entry) =>
    areNearDuplicateTexts(entry.normalizedText, normalizedText),
  );
}

function rememberRadarText(text, recentTexts, now) {
  const normalizedText = normalizeRadarText(text);
  if (normalizedText) {
    recentTexts.push({ normalizedText, seenAt: now });
  }
}

function normalizeCommand(text) {
  return text.trim().split(/\s+/, 1)[0].toLowerCase().split("@", 1)[0];
}

function formatRadarMessage(message) {
  const time = message.time_label
    ? `<b>${escapeHtml(message.time_label)}</b>\n\n`
    : "";
  const text = removeRadarSignature((message.text || "").trim());
  return `${time}${escapeHtml(text)}`.trim();
}

async function telegram(method, body = {}) {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(
      `Telegram API ${method} failed: ${
        payload.description || `HTTP ${response.status}`
      }`,
    );
  }

  return payload.result;
}

async function loadSubscribers() {
  try {
    const content = await fs.readFile(SUBSCRIBERS_FILE, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function saveSubscribers(subscribers) {
  const temporaryFile = `${SUBSCRIBERS_FILE}.tmp`;
  await fs.writeFile(
    temporaryFile,
    `${JSON.stringify(subscribers, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryFile, SUBSCRIBERS_FILE);
}

async function subscribe(message) {
  const subscribers = await loadSubscribers();
  const chatId = String(message.chat.id);
  const existing = subscribers.find((item) => item.chatId === chatId);
  const subscriber = {
    chatId,
    username: message.from?.username || message.chat.username || null,
    firstName: message.from?.first_name || message.chat.first_name || null,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    Object.assign(existing, subscriber);
  } else {
    subscribers.push(subscriber);
  }

  await saveSubscribers(subscribers);
}

async function unsubscribe(chatId) {
  const subscribers = await loadSubscribers();
  const remaining = subscribers.filter(
    (subscriber) => subscriber.chatId !== String(chatId),
  );
  if (remaining.length !== subscribers.length) {
    await saveSubscribers(remaining);
  }
}

async function deliverToSubscribers(text) {
  const subscribers = await loadSubscribers();
  let delivered = 0;

  for (const subscriber of subscribers) {
    try {
      await telegram("sendMessage", {
        chat_id: subscriber.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      delivered += 1;
    } catch (error) {
      const description = error instanceof Error ? error.message : "";
      if (
        description.includes("bot was blocked by the user") ||
        description.includes("chat not found")
      ) {
        await unsubscribe(subscriber.chatId);
      }
      console.warn("Не удалось отправить сообщение одному из подписчиков.");
    }
    await sleep(SEND_DELAY_MS);
  }

  return delivered;
}

async function fetchRadarMapMessages() {
  const response = await fetch(RADAR_MAP_API, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`RadarMap API returned HTTP ${response.status}`);
  }

  const state = await response.json();
  if (!Array.isArray(state.recent_messages)) {
    throw new Error("RadarMap response has no recent_messages array");
  }

  return state.recent_messages.filter(
    (message) =>
      message &&
      typeof message === "object" &&
      (typeof message.msg_id === "string" ||
        typeof message.msg_id === "number" ||
        typeof message.text === "string"),
  );
}

async function radarMapLoop() {
  const recentRadarTexts = [];

  while (!stopped) {
    try {
      const messages = await fetchRadarMapMessages();
      const freshMessages = messages
        .filter((message) => !knownRadarMessages.has(radarMessageKey(message)))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      if (!radarInitialized) {
        knownRadarMessages = new Set(messages.map(radarMessageKey));
        radarInitialized = true;
        console.log(`RadarMap подключён. Событий в снимке: ${messages.length}.`);
      } else {
        for (const message of freshMessages) {
          const rawText = message.text || "";
          if (isUnwantedPromotionalMessage(rawText)) {
            console.log("Рекламное или донатное сообщение RadarMap пропущено.");
            knownRadarMessages.add(radarMessageKey(message));
            continue;
          }

          const now = Date.now();
          if (isRecentRadarDuplicate(rawText, recentRadarTexts, now)) {
            console.log("Похожее событие RadarMap пропущено как повторное.");
            knownRadarMessages.add(radarMessageKey(message));
            continue;
          }

          const delivered = await deliverToSubscribers(
            formatRadarMessage(message),
          );
          rememberRadarText(rawText, recentRadarTexts, now);
          knownRadarMessages.add(radarMessageKey(message));
          console.log(
            `Новое событие RadarMap отправлено подписчикам: ${delivered}.`,
          );
        }
      }

      while (knownRadarMessages.size > 5000) {
        const oldest = knownRadarMessages.values().next().value;
        if (oldest === undefined) break;
        knownRadarMessages.delete(oldest);
      }

      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      console.error(
        "Ошибка обновления RadarMap:",
        error instanceof Error ? error.message : error,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function telegramLoop() {
  await telegram("deleteWebhook", { drop_pending_updates: false });
  const bot = await telegram("getMe");
  console.log(`Бот @${bot.username || "без_username"} запущен.`);
  try {
    await telegram("setMyCommands", { commands: TELEGRAM_COMMANDS });
  } catch (error) {
    console.warn("Не удалось установить меню команд:", error.message);
  }

  while (!stopped) {
    try {
      const updates = await telegram("getUpdates", {
        offset: updateOffset,
        timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        updateOffset = update.update_id + 1;
        const message = update.message;
        if (message?.chat?.type !== "private" || !message.text) continue;

        const command = normalizeCommand(message.text);
        if (command === "/start") {
          await subscribe(message);
          await telegram("sendMessage", {
            chat_id: message.chat.id,
            text:
              "Вы подписаны. Я буду присылать новые сообщения с RadarMap.",
          });
        } else if (command === "/stop") {
          await unsubscribe(message.chat.id);
          await telegram("sendMessage", {
            chat_id: message.chat.id,
            text: "Вы отписаны от рассылки.",
          });
        } else if (command === "/help" || command === "/commands") {
          await telegram("sendMessage", {
            chat_id: message.chat.id,
            text: COMMANDS_TEXT,
          });
        }
      }
    } catch (error) {
      if (!stopped) {
        console.error(
          "Ошибка Telegram polling:",
          error instanceof Error ? error.message : error,
        );
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
}

async function main() {
  await Promise.all([telegramLoop(), radarMapLoop()]);
}

process.once("SIGINT", () => {
  stopped = true;
});
process.once("SIGTERM", () => {
  stopped = true;
});

main().catch((error) => {
  console.error("Бот остановлен из-за ошибки запуска:", error);
  process.exitCode = 1;
});