"""RadarMap Telegram subscriber bot with no third-party dependencies."""

from __future__ import annotations

import html
import json
import os
import re
import signal
import threading
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def read_positive_number(value: str | None, fallback: int) -> int:
    try:
        parsed = int(value or "")
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


BOT_DIR = Path(__file__).resolve().parent
SUBSCRIBERS_FILE = BOT_DIR / "subscribers.json"
TELEGRAM_API = "https://api.telegram.org"
RADAR_MAP_API = (
    os.environ.get("RADAR_MAP_API_URL", "").strip()
    or "https://radar-map.ru/api/state"
)
POLL_INTERVAL_SECONDS = read_positive_number(
    os.environ.get("RADAR_MAP_POLL_INTERVAL_MS"), 15_000
) / 1000
DUPLICATE_WINDOW_SECONDS = read_positive_number(
    os.environ.get("RADAR_DUPLICATE_WINDOW_MS"), 30 * 60 * 1000
) / 1000
TELEGRAM_POLL_TIMEOUT_SECONDS = 25
RETRY_DELAY_SECONDS = 5
SEND_DELAY_SECONDS = 0.04
RADAR_SIGNATURE_PATTERN = re.compile(
    r"\s*📡\s*Локатор России\s*[-–—]\s*@locatorru\s*$",
    re.IGNORECASE,
)
TELEGRAM_COMMANDS = [
    {
        "command": "start",
        "description": "Подписаться на новые сообщения",
    },
    {"command": "stop", "description": "Отписаться от рассылки"},
    {"command": "help", "description": "Показать список команд"},
    {"command": "commands", "description": "Показать список команд"},
]
COMMANDS_TEXT = (
    "Доступные команды:\n"
    "/start — подписаться на новые сообщения\n"
    "/stop — отписаться от рассылки\n"
    "/help — показать этот список\n"
    "/commands — показать этот список"
)
FILE_LOCK = threading.Lock()
STOP_EVENT = threading.Event()


def get_token() -> str:
    for name in ("TELEGRAM_BOT_TOKEN", "BOT_TOKEN", "TELEGRAM_TOKEN", "TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    raise RuntimeError(
        "Bot token is missing. Set TELEGRAM_BOT_TOKEN in BotHost."
    )


TOKEN = get_token()


def sleep_interruptibly(seconds: float) -> None:
    STOP_EVENT.wait(seconds)


def request_json(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    payload = None
    headers = {"accept": "application/json"}
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"

    request = Request(url, data=payload, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            details = json.loads(raw).get("description", raw)
        except json.JSONDecodeError:
            details = raw or f"HTTP {error.code}"
        raise RuntimeError(str(details)) from error
    except URLError as error:
        raise RuntimeError(str(error.reason)) from error

    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("API returned invalid JSON") from error
    if not isinstance(result, dict):
        raise RuntimeError("API returned an invalid response")
    return result


def telegram(method: str, body: dict[str, Any] | None = None) -> Any:
    response = request_json(
        f"{TELEGRAM_API}/bot{TOKEN}/{method}",
        method="POST",
        body=body or {},
        timeout=TELEGRAM_POLL_TIMEOUT_SECONDS + 10,
    )
    if not response.get("ok") or "result" not in response:
        raise RuntimeError(
            f"Telegram API {method} failed: "
            f"{response.get('description', 'unknown error')}"
        )
    return response["result"]


def load_subscribers() -> list[dict[str, Any]]:
    try:
        parsed = json.loads(SUBSCRIBERS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    if not isinstance(parsed, list):
        return []
    return parsed


def save_subscribers(subscribers: list[dict[str, Any]]) -> None:
    temporary_file = SUBSCRIBERS_FILE.with_suffix(".json.tmp")
    temporary_file.write_text(
        f"{json.dumps(subscribers, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )
    temporary_file.replace(SUBSCRIBERS_FILE)


def subscribe(message: dict[str, Any]) -> None:
    chat = message.get("chat") or {}
    sender = message.get("from") or {}
    chat_id = str(chat.get("id"))
    subscriber = {
        "chatId": chat_id,
        "username": sender.get("username")
        or chat.get("username")
        or None,
        "firstName": sender.get("first_name")
        or chat.get("first_name")
        or None,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    with FILE_LOCK:
        subscribers = load_subscribers()
        existing = next(
            (item for item in subscribers if item.get("chatId") == chat_id),
            None,
        )
        if existing is None:
            subscribers.append(subscriber)
        else:
            existing.update(subscriber)
        save_subscribers(subscribers)


def unsubscribe(chat_id: str | int) -> None:
    chat_id = str(chat_id)
    with FILE_LOCK:
        subscribers = load_subscribers()
        remaining = [
            item for item in subscribers if item.get("chatId") != chat_id
        ]
        if len(remaining) != len(subscribers):
            save_subscribers(remaining)


def deliver_to_subscribers(text: str) -> int:
    if not text:
        return 0

    with FILE_LOCK:
        subscribers = load_subscribers()
    delivered = 0

    for subscriber in subscribers:
        try:
            telegram(
                "sendMessage",
                {
                    "chat_id": subscriber["chatId"],
                    "text": text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": True,
                },
            )
            delivered += 1
        except Exception as error:
            description = str(error)
            if "bot was blocked by the user" in description or (
                "chat not found" in description
            ):
                unsubscribe(subscriber["chatId"])
            print(
                "Не удалось отправить сообщение одному из подписчиков:",
                description,
                flush=True,
            )
        sleep_interruptibly(SEND_DELAY_SECONDS)

    return delivered


def radar_message_key(message: dict[str, Any]) -> str:
    source = message.get("source_id") or message.get("channel") or "radar-map"
    identifier = message.get("msg_id")
    if identifier is None:
        identifier = f"{message.get('ts', 0)}:{message.get('text', '')}"
    return f"{source}:{identifier}"


def remove_radar_signature(text: str) -> str:
    return RADAR_SIGNATURE_PATTERN.sub("", text).strip()


def normalize_radar_text(text: str) -> str:
    normalized = remove_radar_signature(text).lower().replace("ё", "е")
    return re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE).strip()


def are_near_duplicate_texts(left: str, right: str) -> bool:
    if left == right:
        return True
    if len(left) < 24 or len(right) < 24:
        return False

    left_words = set(left.split())
    right_words = set(right.split())
    union = left_words | right_words
    intersection = left_words & right_words
    length_ratio = min(len(left), len(right)) / max(len(left), len(right))
    return (
        len(intersection) / len(union) >= 0.85
        and length_ratio >= 0.75
    )


def is_recent_radar_duplicate(
    text: str,
    recent_texts: list[tuple[str, float]],
    now: float,
) -> bool:
    normalized_text = normalize_radar_text(text)
    if not normalized_text:
        return False

    recent_texts[:] = [
        (known_text, seen_at)
        for known_text, seen_at in recent_texts
        if now - seen_at <= DUPLICATE_WINDOW_SECONDS
    ]
    return any(
        are_near_duplicate_texts(known_text, normalized_text)
        for known_text, _seen_at in recent_texts
    )


def remember_radar_text(
    text: str,
    recent_texts: list[tuple[str, float]],
    now: float,
) -> None:
    normalized_text = normalize_radar_text(text)
    if normalized_text:
        recent_texts.append((normalized_text, now))


def format_radar_message(message: dict[str, Any]) -> str:
    time_label = message.get("time_label")
    header = f"<b>{html.escape(str(time_label))}</b>\n\n" if time_label else ""
    text = remove_radar_signature(str(message.get("text") or "").strip())
    return f"{header}{html.escape(text)}".strip()


def fetch_radar_messages() -> list[dict[str, Any]]:
    response = request_json(RADAR_MAP_API)
    messages = response.get("recent_messages")
    if not isinstance(messages, list):
        raise RuntimeError(
            "RadarMap response has no recent_messages array"
        )
    return [
        message
        for message in messages
        if isinstance(message, dict)
        and (
            isinstance(message.get("msg_id"), (str, int))
            or isinstance(message.get("text"), str)
        )
    ]


def radar_map_loop() -> None:
    known_keys: set[str] = set()
    known_order: list[str] = []
    recent_radar_texts: list[tuple[str, float]] = []
    initialized = False

    while not STOP_EVENT.is_set():
        try:
            messages = fetch_radar_messages()
            fresh_messages = sorted(
                (
                    message
                    for message in messages
                    if radar_message_key(message) not in known_keys
                ),
                key=lambda message: message.get("ts") or 0,
            )

            if not initialized:
                for message in messages:
                    key = radar_message_key(message)
                    known_keys.add(key)
                    known_order.append(key)
                initialized = True
                print(
                    f"RadarMap подключён. Событий в снимке: {len(messages)}.",
                    flush=True,
                )
            else:
                for message in fresh_messages:
                    raw_text = str(message.get("text") or "")
                    now = time.monotonic()
                    if is_recent_radar_duplicate(
                        raw_text,
                        recent_radar_texts,
                        now,
                    ):
                        print(
                            "Похожее событие RadarMap пропущено как повторное.",
                            flush=True,
                        )
                        key = radar_message_key(message)
                        known_keys.add(key)
                        known_order.append(key)
                        continue

                    delivered = deliver_to_subscribers(
                        format_radar_message(message)
                    )
                    remember_radar_text(raw_text, recent_radar_texts, now)
                    key = radar_message_key(message)
                    known_keys.add(key)
                    known_order.append(key)
                    print(
                        "Новое событие RadarMap отправлено подписчикам: "
                        f"{delivered}.",
                        flush=True,
                    )

            while len(known_order) > 5000:
                known_keys.discard(known_order.pop(0))
            sleep_interruptibly(POLL_INTERVAL_SECONDS)
        except Exception as error:
            if not STOP_EVENT.is_set():
                print("Ошибка обновления RadarMap:", error, flush=True)
                sleep_interruptibly(RETRY_DELAY_SECONDS)


def send_command(chat_id: int, text: str) -> None:
    telegram("sendMessage", {"chat_id": chat_id, "text": text})


def normalize_command(text: str) -> str:
    command = text.strip().split(maxsplit=1)[0].lower()
    return command.split("@", maxsplit=1)[0]


def register_telegram_commands() -> None:
    try:
        telegram("setMyCommands", {"commands": TELEGRAM_COMMANDS})
    except Exception as error:
        print("Не удалось установить меню команд:", error, flush=True)


def telegram_loop() -> None:
    update_offset = 0
    telegram("deleteWebhook", {"drop_pending_updates": False})
    bot = telegram("getMe")
    print(f"Бот @{bot.get('username', 'без_username')} запущен.", flush=True)
    register_telegram_commands()

    while not STOP_EVENT.is_set():
        try:
            updates = telegram(
                "getUpdates",
                {
                    "offset": update_offset,
                    "timeout": TELEGRAM_POLL_TIMEOUT_SECONDS,
                    "allowed_updates": ["message"],
                },
            )
            for update in updates:
                update_offset = update["update_id"] + 1
                message = update.get("message") or {}
                chat = message.get("chat") or {}
                text = message.get("text")
                if chat.get("type") != "private" or not text:
                    continue

                command = normalize_command(text)
                if command == "/start":
                    subscribe(message)
                    send_command(
                        chat["id"],
                        "Вы подписаны. Я буду присылать новые сообщения "
                        "с RadarMap.",
                    )
                elif command == "/stop":
                    unsubscribe(chat["id"])
                    send_command(chat["id"], "Вы отписаны от рассылки.")
                elif command in {"/help", "/commands"}:
                    send_command(chat["id"], COMMANDS_TEXT)
        except Exception as error:
            if not STOP_EVENT.is_set():
                print("Ошибка Telegram polling:", error, flush=True)
                sleep_interruptibly(RETRY_DELAY_SECONDS)


def stop_bot(_signum: int, _frame: Any) -> None:
    STOP_EVENT.set()


def main() -> None:
    signal.signal(signal.SIGINT, stop_bot)
    signal.signal(signal.SIGTERM, stop_bot)
    radar_thread = threading.Thread(target=radar_map_loop, daemon=True)
    radar_thread.start()
    telegram_loop()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Бот остановлен из-за ошибки запуска: {error}", flush=True)
        raise