import { db, telegramSubscribers } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  renderRadarMapScreenshot,
  sendTelegramPhoto,
} from "./radar-map-image";

type TelegramChat = {
  id: number;
  username?: string;
  type?: string;
  first_name?: string;
};

type TelegramMessage = {
  chat: TelegramChat;
  text?: string;
  from?: TelegramChat;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type RadarMapMessage = {
  msg_id?: string | number;
  text?: string;
  ts?: number;
  time_label?: string;
  source_id?: string;
  source_label?: string;
  channel?: string;
};

type RadarMapState = {
  recent_messages?: RadarMapMessage[];
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramBotOptions = {
  token: string;
  radarMapApiUrl: string;
  radarMapPollIntervalMs: number;
  radarDuplicateWindowMs: number;
};

const API_BASE_URL = "https://api.telegram.org";
const DEFAULT_RADAR_MAP_API_URL = "https://radar-map.ru/api/state";
const POLL_TIMEOUT_SECONDS = 25;
const RETRY_DELAY_MS = 5_000;
const SEND_DELAY_MS = 40;
const RADAR_MAP_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RADAR_DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
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
  {
    command: "start",
    description: "Подписаться на новые сообщения",
  },
  { command: "stop", description: "Отписаться от рассылки" },
  { command: "help", description: "Показать список команд" },
  { command: "commands", description: "Показать список команд" },
  { command: "map", description: "Показать текущую карту RadarMap" },
];
const COMMANDS_TEXT =
  "Доступные команды:\n" +
  "/start — подписаться на новые сообщения\n" +
  "/stop — отписаться от рассылки\n" +
  "/help — показать этот список\n" +
  "/commands — показать этот список\n" +
  "/map — показать текущую карту RadarMap";

function readTelegramToken(): string | undefined {
  for (const name of [
    "TELEGRAM_BOT_TOKEN",
    "BOT_TOKEN",
    "TELEGRAM_TOKEN",
    "TOKEN",
  ]) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function subscribeUser(message: TelegramMessage): Promise<void> {
  await db
    .insert(telegramSubscribers)
    .values({
      chatId: String(message.chat.id),
      username: message.from?.username ?? message.chat.username ?? null,
      firstName: message.from?.first_name ?? message.chat.first_name ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: telegramSubscribers.chatId,
      set: {
        username: message.from?.username ?? message.chat.username ?? null,
        firstName: message.from?.first_name ?? message.chat.first_name ?? null,
        updatedAt: new Date(),
      },
    });
}

async function unsubscribeUser(chatId: string | number): Promise<void> {
  await db
    .delete(telegramSubscribers)
    .where(eq(telegramSubscribers.chatId, String(chatId)));
}

async function callTelegramApi<T>(
  options: TelegramBotOptions,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/bot${options.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  let payload: TelegramApiResponse<T>;
  try {
    payload = (await response.json()) as TelegramApiResponse<T>;
  } catch (error) {
    throw new Error(
      `Telegram API returned invalid JSON: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(
      `Telegram API ${method} failed: ${
        payload.description ?? `HTTP ${response.status}`
      }`,
    );
  }

  return payload.result;
}

function radarMessageKey(message: RadarMapMessage): string {
  const source = message.source_id ?? message.channel ?? "radar-map";
  const id = message.msg_id ?? `${message.ts ?? 0}:${message.text ?? ""}`;
  return `${source}:${id}`;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function removeRadarSignature(text: string): string {
  return text.replace(RADAR_SIGNATURE_PATTERN, "").trim();
}

function isUnwantedPromotionalMessage(text: string): boolean {
  const cleanedText = removeRadarSignature(text);
  const heartCount = cleanedText.match(HEART_PATTERN)?.length ?? 0;
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

function normalizeRadarText(text: string): string {
  return removeRadarSignature(text)
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function areNearDuplicateTexts(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }

  if (left.length < 24 || right.length < 24) {
    return false;
  }

  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  const intersectionSize = [...leftWords].filter((word) =>
    rightWords.has(word),
  ).length;
  const unionSize = new Set([...leftWords, ...rightWords]).size;
  const lengthRatio =
    Math.min(left.length, right.length) / Math.max(left.length, right.length);

  return intersectionSize / unionSize >= 0.85 && lengthRatio >= 0.75;
}

type RecentRadarText = {
  normalizedText: string;
  seenAt: number;
};

function isRecentRadarDuplicate(
  message: RadarMapMessage,
  recentTexts: RecentRadarText[],
  now: number,
  windowMs: number,
): boolean {
  const normalizedText = normalizeRadarText(message.text ?? "");
  if (!normalizedText) {
    return false;
  }

  for (let index = recentTexts.length - 1; index >= 0; index -= 1) {
    if (now - recentTexts[index].seenAt > windowMs) {
      recentTexts.splice(index, 1);
    }
  }

  return recentTexts.some((entry) =>
    areNearDuplicateTexts(entry.normalizedText, normalizedText),
  );
}

function rememberRadarText(
  message: RadarMapMessage,
  recentTexts: RecentRadarText[],
  now: number,
): void {
  const normalizedText = normalizeRadarText(message.text ?? "");
  if (normalizedText) {
    recentTexts.push({ normalizedText, seenAt: now });
  }
}

function normalizeCommand(text: string): string {
  return text.trim().split(/\s+/, 1)[0].toLowerCase().split("@", 1)[0];
}

function formatRadarMapMessage(message: RadarMapMessage): string {
  const time = message.time_label
    ? `<b>${escapeTelegramHtml(message.time_label)}</b>\n\n`
    : "";
  const text = removeRadarSignature(message.text?.trim() ?? "");

  return `${time}${escapeTelegramHtml(text)}`.trim();
}

async function fetchRadarMapState(
  apiUrl: string,
): Promise<RadarMapMessage[]> {
  const response = await fetch(apiUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(RADAR_MAP_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`RadarMap API returned HTTP ${response.status}`);
  }

  const state = (await response.json()) as RadarMapState;
  if (!Array.isArray(state.recent_messages)) {
    throw new Error("RadarMap API response has no recent_messages array");
  }

  return state.recent_messages.filter(
    (message): message is RadarMapMessage =>
      typeof message === "object" &&
      message !== null &&
      (typeof message.msg_id === "string" ||
        typeof message.msg_id === "number" ||
        typeof message.text === "string"),
  );
}

async function deliverToSubscribers(
  options: TelegramBotOptions,
  text: string,
  includeMap = false,
): Promise<number> {
  const subscribers = await db.select().from(telegramSubscribers);
  let delivered = 0;
  let mapPath: string | undefined;

  if (includeMap && subscribers.length > 0) {
    try {
      mapPath = await renderRadarMapScreenshot();
    } catch (error) {
      logger.warn({ err: error }, "Could not render RadarMap screenshot");
    }
  }

  for (const subscriber of subscribers) {
    try {
      await callTelegramApi(options, "sendMessage", {
        chat_id: subscriber.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      if (mapPath) {
        try {
          await sendTelegramPhoto(
            options.token,
            subscriber.chatId,
            mapPath,
            "Текущая карта RadarMap. Данные могут быть приблизительными.",
          );
        } catch (error) {
          logger.warn(
            { err: error, chatId: subscriber.chatId },
            "RadarMap screenshot could not be delivered",
          );
        }
      }
      delivered += 1;
    } catch (error) {
      const description = error instanceof Error ? error.message : "";
      if (
        description.includes("bot was blocked by the user") ||
        description.includes("chat not found")
      ) {
        await unsubscribeUser(subscriber.chatId);
      }
      logger.warn(
        { err: error },
        "RadarMap message could not be delivered to a subscriber",
      );
    }

    await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
  }

  return delivered;
}

async function sendMapToChat(
  options: TelegramBotOptions,
  chatId: string | number,
): Promise<void> {
  try {
    const mapPath = await renderRadarMapScreenshot();
    await sendTelegramPhoto(
      options.token,
      chatId,
      mapPath,
      "Текущая карта RadarMap. Данные могут быть приблизительными.",
    );
  } catch (error) {
    logger.warn({ err: error, chatId }, "Could not send RadarMap screenshot");
    await callTelegramApi(options, "sendMessage", {
      chat_id: chatId,
      text: "Не удалось подготовить снимок карты. Живая карта: https://radar-map.ru/",
      disable_web_page_preview: false,
    });
  }
}

async function runRadarMapPoller(
  options: TelegramBotOptions,
  isStopped: () => boolean,
): Promise<void> {
  const knownKeys = new Set<string>();
  const recentRadarTexts: RecentRadarText[] = [];
  let initialized = false;

  while (!isStopped()) {
    try {
      const messages = await fetchRadarMapState(options.radarMapApiUrl);
      const freshMessages = messages
        .filter((message) => !knownKeys.has(radarMessageKey(message)))
        .sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0));

      if (!initialized) {
        for (const message of messages) {
          knownKeys.add(radarMessageKey(message));
        }
        initialized = true;
        logger.info(
          { messageCount: messages.length, apiUrl: options.radarMapApiUrl },
          "RadarMap source connected",
        );
      } else {
        for (const message of freshMessages) {
          if (isUnwantedPromotionalMessage(message.text ?? "")) {
            logger.info(
              { messageId: message.msg_id },
              "RadarMap promotional message suppressed",
            );
            knownKeys.add(radarMessageKey(message));
            continue;
          }

          const now = Date.now();
          if (
            isRecentRadarDuplicate(
              message,
              recentRadarTexts,
              now,
              options.radarDuplicateWindowMs,
            )
          ) {
            logger.info(
              { messageId: message.msg_id },
              "RadarMap near-duplicate suppressed",
            );
            knownKeys.add(radarMessageKey(message));
            continue;
          }

          const delivered = await deliverToSubscribers(
            options,
            formatRadarMapMessage(message),
            true,
          );
          rememberRadarText(message, recentRadarTexts, now);
          logger.info(
            {
              messageId: message.msg_id,
              source: message.source_label ?? message.source_id,
              delivered,
            },
            "RadarMap message delivered",
          );
          knownKeys.add(radarMessageKey(message));
        }
      }

      while (knownKeys.size > 5_000) {
        const oldestKey = knownKeys.values().next().value;
        if (oldestKey === undefined) {
          break;
        }
        knownKeys.delete(oldestKey);
      }

      await new Promise((resolve) =>
        setTimeout(resolve, options.radarMapPollIntervalMs),
      );
    } catch (error) {
      if (!isStopped()) {
        logger.error({ err: error }, "RadarMap polling error; retrying");
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
}

export function startTelegramBot() {
  const token = readTelegramToken();
  if (!token) {
    logger.warn(
      "No Telegram bot token configured; Telegram subscriber bot is disabled",
    );
    return { stop: () => undefined };
  }

  const options: TelegramBotOptions = {
    token,
    radarMapApiUrl:
      process.env["RADAR_MAP_API_URL"]?.trim() || DEFAULT_RADAR_MAP_API_URL,
    radarMapPollIntervalMs: readPositiveIntEnv(
      "RADAR_MAP_POLL_INTERVAL_MS",
      15_000,
    ),
    radarDuplicateWindowMs: readPositiveIntEnv(
      "RADAR_DUPLICATE_WINDOW_MS",
      DEFAULT_RADAR_DUPLICATE_WINDOW_MS,
    ),
  };

  let stopped = false;
  let offset = 0;

  const stop = () => {
    stopped = true;
  };

  const run = async () => {
    try {
      await callTelegramApi(options, "deleteWebhook", {
        drop_pending_updates: false,
      });
      const bot = await callTelegramApi<{ username?: string }>(
        options,
        "getMe",
      );
      logger.info(
        { botUsername: bot.username, radarMapApiUrl: options.radarMapApiUrl },
        "Telegram subscriber bot started",
      );
      try {
        await callTelegramApi(options, "setMyCommands", {
          commands: TELEGRAM_COMMANDS,
        });
      } catch (error) {
        logger.warn({ err: error }, "Could not set Telegram command menu");
      }
    } catch (error) {
      logger.error({ err: error }, "Telegram bot could not start");
      return;
    }

    void runRadarMapPoller(options, () => stopped);

    while (!stopped) {
      try {
        const updates = await callTelegramApi<TelegramUpdate[]>(
          options,
          "getUpdates",
          {
            offset,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ["message"],
          },
        );

        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;

          if (message?.chat.type !== "private" || !message.text) {
            continue;
          }

          const command = normalizeCommand(message.text);

          if (command === "/start") {
            await subscribeUser(message);
            await callTelegramApi(options, "sendMessage", {
              chat_id: message.chat.id,
              text:
                "Вы подписаны. Я буду присылать новые сообщения с RadarMap.",
            });
          } else if (command === "/stop") {
            await unsubscribeUser(message.chat.id);
            await callTelegramApi(options, "sendMessage", {
              chat_id: message.chat.id,
              text: "Вы отписаны от рассылки.",
            });
          } else if (command === "/help" || command === "/commands") {
            await callTelegramApi(options, "sendMessage", {
              chat_id: message.chat.id,
              text: COMMANDS_TEXT,
            });
          } else if (command === "/map") {
            await sendMapToChat(options, message.chat.id);
          }
        }
      } catch (error) {
        if (!stopped) {
          logger.error({ err: error }, "Telegram polling error; retrying");
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    logger.info("Telegram subscriber bot stopped");
  };

  void run();

  return { stop };
}