import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RADAR_MAP_URL = "https://radar-map.ru/";
const SCREENSHOT_CACHE_TTL_MS = 30_000;
const SCREENSHOT_WIDTH = 1280;
const SCREENSHOT_HEIGHT = 900;
const CROPPED_HEIGHT = 820;

type ScreenshotCache = {
  filePath: string;
  directory: string;
  createdAt: number;
};

let screenshotCache: ScreenshotCache | undefined;

function readToolPath(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function renderRadarMapScreenshot(): Promise<string> {
  const now = Date.now();
  if (
    screenshotCache &&
    now - screenshotCache.createdAt < SCREENSHOT_CACHE_TTL_MS &&
    (await pathExists(screenshotCache.filePath))
  ) {
    return screenshotCache.filePath;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "radarmap-shot-"));
  const rawPath = path.join(directory, "radarmap-raw.png");
  const croppedPath = path.join(directory, "radarmap.png");
  const chromiumPath = readToolPath("CHROMIUM_PATH", "/repl/tools/bin/chromium");
  const imageMagickPath = readToolPath("IMAGE_MAGICK_PATH", "convert");

  try {
    await execFileAsync(
      chromiumPath,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${directory}/profile`,
        `--window-size=${SCREENSHOT_WIDTH},${SCREENSHOT_HEIGHT}`,
        "--virtual-time-budget=7000",
        `--screenshot=${rawPath}`,
        RADAR_MAP_URL,
      ],
      {
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    let outputPath = rawPath;
    try {
      await execFileAsync(
        imageMagickPath,
        [
          rawPath,
          "-crop",
          `${SCREENSHOT_WIDTH}x${CROPPED_HEIGHT}+0+0`,
          "+repage",
          "-strip",
          "-quality",
          "88",
          croppedPath,
        ],
        { timeout: 15_000, maxBuffer: 256 * 1024 },
      );
      outputPath = croppedPath;
    } catch {
      // The original screenshot is still a valid Telegram-compatible PNG.
    }

    const previousCache = screenshotCache;
    screenshotCache = {
      filePath: outputPath,
      directory,
      createdAt: Date.now(),
    };

    if (previousCache && previousCache.directory !== directory) {
      await rm(previousCache.directory, { recursive: true, force: true });
    }

    return outputPath;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `Could not render RadarMap screenshot: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}

export async function sendTelegramPhoto(
  token: string,
  chatId: string | number,
  filePath: string,
  caption?: string,
): Promise<void> {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set(
    "photo",
    new Blob([await readFile(filePath)], { type: "image/png" }),
    "radar-map.png",
  );
  if (caption) {
    form.set("caption", caption);
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendPhoto`,
    {
      method: "POST",
      body: form,
    },
  );
  const payload = (await response.json()) as {
    ok: boolean;
    description?: string;
  };

  if (!response.ok || !payload.ok) {
    throw new Error(
      `Telegram API sendPhoto failed: ${
        payload.description ?? `HTTP ${response.status}`
      }`,
    );
  }
}