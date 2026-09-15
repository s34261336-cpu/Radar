"""RadarMap Telegram subscriber bot with no third-party dependencies."""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
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
RADAR_MAP_URL = "https://radar-map.ru/"
CHROMIUM_PATH = (
    os.environ.get("CHROMIUM_PATH", "").strip()
    or "/repl/tools/bin/chromium"
)
POLL_INTERVAL_SECONDS = read_positive_number(
    os.environ.get("RADAR_MAP_POLL_INTERVAL_MS"), 15_000
) / 1000
DUPLICATE_WINDOW_SECONDS = read_positive_number(
    os.environ.get("RADAR_DUPLICATE_WINDOW_MS"), 30 * 60 * 1000
) / 1000
MAP_SCREENSHOT_CACHE_SECONDS = 30
TELEGRAM_POLL_TIMEOUT_SECONDS = 25
RETRY_DELAY_SECONDS = 5
SEND_DELAY_SECONDS = 0.04
RADAR_SIGNATURE_PATTERN = re.compile(
    r"\s*📡\s*Локатор России\s*[-–—]\s*@locatorru\s*$",
    re.IGNORECASE,
)
DONATION_LINK_PATTERN = re.compile(
    r"(?:https?://)?(?:www\.)?(?:pay\.)?cloudtips\.ru\b",
    re.IGNORECASE,
)
SUPPORT_APPEAL_PATTERN = re.compile(
    r"\b(?:поддержк\w*|деятельност\w*|донат\w*|пожертвован\w*|помощ\w*)\b",
    re.IGNORECASE,
)
WARM_APPEAL_PATTERN = re.compile(
    r"(?:наши\s+дорогие\s+близкие|спасибо\s+огромн\w*\s+за\s+поддержк\w*|"
    r"поддержк\w*\s+(?:нашей|нашу|нашего)\s+деятельност\w*)",
    re.IGNORECASE,
)
EXTERNAL_LINK_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)
HEART_PATTERN = re.compile(r"(?:❤️|❤|♥️|💕|💖|💗|💓|💞|💘)")
TELEGRAM_COMMANDS = [
    {
        "command": "start",
        "description": "Подписаться на новые сообщения",
    },
    {"command": "stop", "description": "Отписаться от рассылки"},
    {"command": "help", "description": "Показать список команд"},
    {"command": "commands", "description": "Показать список команд"},
    {"command": "map", "description": "Открыть живую карту RadarMap"},
]
COMMANDS_TEXT = (
    "Доступные команды:\n"
    "/start — подписаться на новые сообщения\n"
    "/stop — отписаться от рассылки\n"
    "/help — показать этот список\n"
    "/commands — показать этот список\n"
    "/map — получить фото живой карты RadarMap\n"
)
FILE_LOCK = threading.Lock()
MAP_SCREENSHOT_LOCK = threading.Lock()
STOP_EVENT = threading.Event()
MAP_SCREENSHOT_PATH: Path | None = None
MAP_SCREENSHOT_DIRECTORY: Path | None = None
MAP_SCREENSHOT_CREATED_AT = 0.0


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


def request_multipart(
    url: str,
    *,
    fields: dict[str, str],
    file_field: str,
    file_path: Path,
    file_name: str,
    content_type: str,
    timeout: int = 60,
) -> dict[str, Any]:
    boundary = f"----RadarMapBot{os.urandom(12).hex()}"
    parts: list[bytes] = []

    for name, value in fields.items():
        parts.extend(
            [
                f"--{boundary}\r\n".encode("ascii"),
                (
                    f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                ).encode("utf-8"),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )

    parts.extend(
        [
            f"--{boundary}\r\n".encode("ascii"),
            (
                f'Content-Disposition: form-data; name="{file_field}"; '
                f'filename="{file_name}"\r\n'
            ).encode("utf-8"),
            f"Content-Type: {content_type}\r\n\r\n".encode("ascii"),
            file_path.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode("ascii"),
        ]
    )

    request = Request(
        url,
        data=b"".join(parts),
        headers={
            "accept": "application/json",
            "content-type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
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
        error = RuntimeError(
            f"Telegram API {method} failed: "
            f"{response.get('description', 'unknown error')}"
        )
        setattr(error, "telegram_error_code", response.get("error_code"))
        raise error
    return response["result"]


def telegram_photo(
    chat_id: int | str,
    photo_path: Path,
    caption: str | None = None,
) -> Any:
    fields = {"chat_id": str(chat_id)}
    if caption:
        fields["caption"] = caption

    response = request_multipart(
        f"{TELEGRAM_API}/bot{TOKEN}/sendPhoto",
        fields=fields,
        file_field="photo",
        file_path=photo_path,
        file_name="radarmap.png",
        content_type="image/png",
    )
    if not response.get("ok") or "result" not in response:
        error = RuntimeError(
            "Telegram API sendPhoto failed: "
            f"{response.get('description', 'unknown error')}"
        )
        setattr(error, "telegram_error_code", response.get("error_code"))
        raise error
    return response["result"]


def is_polling_conflict(error: Exception) -> bool:
    return bool(
        getattr(error, "telegram_error_code", None) == 409
        or "terminated by other getUpdates request" in str(error)
    )


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


def is_unwanted_promotional_message(text: str) -> bool:
    cleaned_text = remove_radar_signature(text)
    heart_count = len(HEART_PATTERN.findall(cleaned_text))
    has_donation_link = bool(DONATION_LINK_PATTERN.search(cleaned_text))
    has_support_appeal = bool(
        SUPPORT_APPEAL_PATTERN.search(cleaned_text)
        or WARM_APPEAL_PATTERN.search(cleaned_text)
    )
    return bool(
        has_donation_link
        or (
            has_support_appeal
            and (EXTERNAL_LINK_PATTERN.search(cleaned_text) or heart_count >= 2)
        )
    )


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


def render_radar_map_screenshot() -> Path:
    global MAP_SCREENSHOT_CREATED_AT
    global MAP_SCREENSHOT_DIRECTORY
    global MAP_SCREENSHOT_PATH

    with MAP_SCREENSHOT_LOCK:
        now = time.monotonic()
        if (
            MAP_SCREENSHOT_PATH is not None
            and MAP_SCREENSHOT_PATH.exists()
            and now - MAP_SCREENSHOT_CREATED_AT < MAP_SCREENSHOT_CACHE_SECONDS
        ):
            return MAP_SCREENSHOT_PATH

        directory = Path(tempfile.mkdtemp(prefix="radarmap-shot-"))
        output_path = directory / "radarmap.png"
        command = [
            CHROMIUM_PATH,
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={directory / 'profile'}",
            "--window-size=1280,900",
            "--virtual-time-budget=7000",
            "--run-all-compositor-stages-before-draw",
            f"--screenshot={output_path}",
            RADAR_MAP_URL,
        ]

        try:
            subprocess.run(
                command,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=45,
            )
        except (
            OSError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
        ) as error:
            shutil.rmtree(directory, ignore_errors=True)
            details = str(error)
            if isinstance(error, subprocess.CalledProcessError):
                details = error.stderr[-1000:].strip() or details
            raise RuntimeError(
                f"Не удалось сделать снимок RadarMap: {details}"
            ) from error

        if not output_path.exists() or output_path.stat().st_size == 0:
            shutil.rmtree(directory, ignore_errors=True)
            raise RuntimeError("Chromium вернул пустой снимок RadarMap")

        old_directory = MAP_SCREENSHOT_DIRECTORY
        MAP_SCREENSHOT_DIRECTORY = directory
        MAP_SCREENSHOT_PATH = output_path
        MAP_SCREENSHOT_CREATED_AT = time.monotonic()
        if old_directory is not None and old_directory != directory:
            shutil.rmtree(old_directory, ignore_errors=True)
        return output_path


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
                    if is_unwanted_promotional_message(raw_text):
                        print(
                            "Рекламное или донатное сообщение RadarMap "
                            "пропущено.",
                            flush=True,
                        )
                        key = radar_message_key(message)
                        known_keys.add(key)
                        known_order.append(key)
                        continue

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
    try:
        telegram("deleteWebhook", {"drop_pending_updates": False})
        bot = telegram("getMe")
        print(f"Бот @{bot.get('username', 'без_username')} запущен.", flush=True)
        register_telegram_commands()
    except Exception as error:
        if is_polling_conflict(error):
            raise RuntimeError(
                "Этот токен Telegram уже используется другим экземпляром "
                "бота. Остановите старый экземпляр или создайте новый токен "
                "в BotFather."
            ) from error
        raise

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
                elif command == "/map":
                    try:
                        map_image = render_radar_map_screenshot()
                        telegram_photo(
                            chat["id"],
                            map_image,
                            "Живая карта RadarMap",
                        )
                    except Exception as error:
                        print(
                            "Не удалось отправить фото RadarMap:",
                            error,
                            flush=True,
                        )
                        send_command(
                            chat["id"],
                            "Не удалось подготовить фото карты. "
                            "Попробуйте отправить /map ещё раз через минуту.",
                        )
        except Exception as error:
            if is_polling_conflict(error):
                raise RuntimeError(
                    "Этот токен Telegram уже используется другим экземпляром "
                    "бота. Остановите старый экземпляр или создайте новый "
                    "токен в BotFather."
                ) from error
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