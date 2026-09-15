import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RADAR_MAP_URL = "https://radar-map.ru/";
const SCREENSHOT_CACHE_TTL_MS = 30_000;
const SCREENSHOT_WIDTH = 1280;
const SCREENSHOT_HEIGHT = 900;

type ScreenshotCache = {
  filePath: string;
  directory: string;
  createdAt: number;
};

let screenshotCache: ScreenshotCache | undefined;

function readToolPath(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine a free local port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForDevToolsTarget(port: number): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await response.json()) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const target = targets.find(
        (item) => item.type === "page" && item.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) {
        return target.webSocketDebuggerUrl;
      }
    } catch {
      // Chromium is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Chromium DevTools target did not start");
}

async function openDevToolsSocket(
  url: string,
): Promise<{
  socket: WebSocket;
  command: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}> {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data)) as {
      id?: number;
      error?: { message?: string };
      result?: unknown;
    };
    if (payload.id === undefined) {
      return;
    }

    const request = pending.get(payload.id);
    if (!request) {
      return;
    }
    pending.delete(payload.id);
    if (payload.error) {
      request.reject(new Error(payload.error.message ?? "DevTools command failed"));
    } else {
      request.resolve(payload.result);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not connect to Chromium DevTools")),
      { once: true },
    );
  });

  return {
    socket,
    command: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      }),
  };
}

const CLEAN_MAP_SCRIPT = `
  (() => {
    const style = document.createElement("style");
    style.textContent = \`
      html, body {
        width: 100% !important;
        height: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: #dce5ec !important;
      }
      .top-chrome,
      .feed,
      .site-footer,
      .cookie-consent,
      #map-toolbar,
      #mapPrefsPop,
      #serviceBanner,
      #map-updating,
      .ol-control {
        display: none !important;
      }
      .main,
      .map-wrap,
      #map {
        position: fixed !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        min-height: 100vh !important;
        margin: 0 !important;
        padding: 0 !important;
      }
    \`;
    document.head.appendChild(style);
    if (window.RadarMapConsent) {
      window.RadarMapConsent.acknowledge();
    }
    window.dispatchEvent(new Event("resize"));
  })();
`;

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
  const outputPath = path.join(directory, "radarmap.png");
  const chromiumPath = readToolPath("CHROMIUM_PATH", "/repl/tools/bin/chromium");
  const port = await findFreePort();
  let browser: ChildProcess | undefined;
  let socket: WebSocket | undefined;

  try {
    browser = spawn(
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
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        "about:blank",
      ],
      {
        stdio: "ignore",
      },
    );

    const targetUrl = await waitForDevToolsTarget(port);
    const devTools = await openDevToolsSocket(targetUrl);
    socket = devTools.socket;
    await devTools.command("Page.enable");
    await devTools.command("Runtime.enable");
    await devTools.command("Page.navigate", { url: RADAR_MAP_URL });
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    await devTools.command("Runtime.evaluate", {
      expression: CLEAN_MAP_SCRIPT,
      returnByValue: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const screenshot = (await devTools.command("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    })) as { data?: string };

    if (!screenshot.data) {
      throw new Error("Chromium returned an empty screenshot");
    }
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));

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
  } finally {
    socket?.close();
    if (browser && !browser.killed) {
      browser.kill("SIGTERM");
    }
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