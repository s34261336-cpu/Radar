import { db, telegramSubscribers } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

type TelegramChat = {
  id: number;
  username?: string;
  type?: string;
  first_name?: string;
};

type TelegramChannelPost = {
  message_id: number;
  chat: TelegramChat;
};

type TelegramMessage = {
  chat: TelegramChat;
  text?: string;
  from?: TelegramChat;
};

type TelegramUpdate = {
  update_id: number;
  channel_post?: TelegramChannelPost;
  message?: TelegramMessage;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramBotOptions = {
  token: string;
  sourceChat: string;
};

const API_BASE_URL = "https://api.telegram.org";
const POLL_TIMEOUT_SECONDS = 25;
const RETRY_DELAY_MS = 5_000;
const SEND_DELAY_MS = 40;

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }
  return value;
}

function chatMatches(chat: TelegramChat, configuredChat: string): boolean {
  if (configuredChat.startsWith("@")) {
    return chat.username?.toLowerCase() === configuredChat.slice(1).toLowerCase();
  }

  return String(chat.id) === configuredChat;
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

async function unsubscribeUser(chatId: number): Promise<void> {
  await db
    .delete(telegramSubscribers)
    .where(eq(telegramSubscribers.chatId, String(chatId)));
}

async function callTelegramApi<T>(
  options: TelegramBotOptions,
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(
    `${API_BASE_URL}/bot${options.token}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  let payload: TelegramApiResponse<T>;
  try {
    payload = (await response.json()) as TelegramApiResponse<T>;
  } catch (error) {
    throw new Error(
      `Telegram API returned invalid JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }

  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(
      `Telegram API ${method} failed: ${payload.description ?? `HTTP ${response.status}`}`,
    );
  }

  return payload.result;
}

export function startTelegramBot() {
  const options: TelegramBotOptions = {
    token: readRequiredEnv("TELEGRAM_BOT_TOKEN"),
    sourceChat: process.env["TELEGRAM_SOURCE_CHAT"]?.trim() || "@radarrussiia",
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
        { botUsername: bot.username, sourceChat: options.sourceChat },
        "Telegram copy bot started",
      );
    } catch (error) {
      logger.error({ err: error }, "Telegram bot could not start");
      return;
    }

    while (!stopped) {
      try {
        const updates = await callTelegramApi<TelegramUpdate[]>(
          options,
          "getUpdates",
          {
            offset,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ["channel_post", "message"],
          },
        );

        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;

          if (message?.chat.type === "private" && message.text) {
            const command = message.text.trim().split(/\s+/, 1)[0].toLowerCase();

            if (command === "/start") {
              await subscribeUser(message);
              await callTelegramApi(options, "sendMessage", {
                chat_id: message.chat.id,
                text:
                  "Вы подписаны. Я буду присылать новые публикации из канала @radarrussiia.",
              });
            } else if (command === "/stop") {
              await unsubscribeUser(message.chat.id);
              await callTelegramApi(options, "sendMessage", {
                chat_id: message.chat.id,
                text: "Вы отписаны от рассылки.",
              });
            }
          }

          const post = update.channel_post;

          if (!post || !chatMatches(post.chat, options.sourceChat)) {
            continue;
          }

          const subscribers = await db.select().from(telegramSubscribers);
          let delivered = 0;

          for (const subscriber of subscribers) {
            try {
              await callTelegramApi(options, "copyMessage", {
                chat_id: subscriber.chatId,
                from_chat_id: post.chat.id,
                message_id: post.message_id,
              });
              delivered += 1;
            } catch (error) {
              const description = error instanceof Error ? error.message : "";
              if (
                description.includes("bot was blocked by the user") ||
                description.includes("chat not found")
              ) {
                await unsubscribeUser(Number(subscriber.chatId));
              }
              logger.warn(
                { err: error },
                "Telegram post could not be delivered to a subscriber",
              );
            }

            await new Promise((resolve) => setTimeout(resolve, SEND_DELAY_MS));
          }

          logger.info(
            {
              sourceChat: options.sourceChat,
              messageId: post.message_id,
              subscriberCount: subscribers.length,
              delivered,
            },
            "Telegram channel post delivered",
          );
        }
      } catch (error) {
        if (!stopped) {
          logger.error({ err: error }, "Telegram polling error; retrying");
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    logger.info("Telegram copy bot stopped");
  };

  void run();

  return { stop };
}