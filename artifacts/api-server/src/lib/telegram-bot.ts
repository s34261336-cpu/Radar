import { logger } from "./logger";

type TelegramChat = {
  id: number;
  username?: string;
};

type TelegramChannelPost = {
  message_id: number;
  chat: TelegramChat;
};

type TelegramUpdate = {
  update_id: number;
  channel_post?: TelegramChannelPost;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramBotOptions = {
  token: string;
  sourceChat: string;
  destinationChat: string;
};

const API_BASE_URL = "https://api.telegram.org";
const POLL_TIMEOUT_SECONDS = 25;
const RETRY_DELAY_MS = 5_000;

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
    destinationChat:
      process.env["TELEGRAM_DESTINATION_CHAT"]?.trim() || "@radarrussiia",
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
            allowed_updates: ["channel_post"],
          },
        );

        for (const update of updates) {
          offset = update.update_id + 1;
          const post = update.channel_post;

          if (!post || !chatMatches(post.chat, options.sourceChat)) {
            continue;
          }

          await callTelegramApi(options, "copyMessage", {
            chat_id: options.destinationChat,
            from_chat_id: post.chat.id,
            message_id: post.message_id,
          });

          logger.info(
            {
              sourceChat: options.sourceChat,
              destinationChat: options.destinationChat,
              messageId: post.message_id,
            },
            "Telegram channel post copied",
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