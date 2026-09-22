import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

class SetupError extends Error {}

function prompt(label, secret = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new SetupError("Run this helper in an interactive terminal. Secrets are accepted only by masked prompts, never command arguments.");
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    input.once("close", () => {
      if (!settled) reject(new SetupError("Terminal input closed. Setup was not completed."));
    });
    input.once("SIGINT", () => {
      settled = true;
      muted = false;
      input.close();
      reject(new SetupError("Cancelled."));
    });
    input.question(label, (answer) => {
      settled = true;
      muted = false;
      input.close();
      if (secret) process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = secret;
  });
}

async function telegram(token, method, body = {}) {
  let response;
  let data;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });
    data = await response.json();
  } catch {
    throw new SetupError("Telegram network/response failure. Retry later. No raw URL or exception is printed because it may contain the token.");
  }
  if (!response.ok || data?.ok !== true) {
    throw new SetupError(`Telegram ${method} failed (HTTP ${response.status}). Check the intended bot token and Telegram status, then retry.`);
  }
  return data.result;
}

async function discover(token) {
  const webhook = await telegram(token, "getWebhookInfo");
  if (webhook.url) {
    throw new SetupError("This bot already has a webhook. Discovery will not remove it or interfere with an existing bot. Use a new dedicated bot.");
  }
  const challenge = `/bind ${randomBytes(16).toString("hex")}`;
  const since = Math.floor(Date.now() / 1_000) - 5;
  console.log(`From your own PRIVATE chat with this bot, send exactly:\n${challenge}`);
  await prompt("Press Enter after sending the challenge: ");
  if (Date.now() / 1_000 - since > 300) {
    throw new SetupError("The five-minute challenge expired. Rerun discovery.");
  }
  const updates = await telegram(token, "getUpdates", {
    timeout: 0, limit: 100, allowed_updates: ["message"],
  });
  if (Date.now() / 1_000 - since > 300) {
    throw new SetupError("The five-minute challenge expired. Rerun discovery.");
  }
  if (!Array.isArray(updates)) throw new SetupError("Unexpected Telegram update response.");
  const candidates = updates
    .map((update) => update.message)
    .filter((message) =>
      message?.text === challenge &&
      message?.chat?.type === "private" &&
      Number.isSafeInteger(message?.from?.id) &&
      message.from.id > 0 &&
      !message.from.is_bot &&
      message.chat.id === message.from.id &&
      message.date >= since,
    );
  const ids = [...new Set(candidates.map((message) => String(message.from.id)))];
  if (ids.length !== 1) {
    throw new SetupError("No unique matching private challenge was found. Use a new dedicated bot and rerun discovery; do not guess an owner ID.");
  }
  const id = ids[0];
  console.log(`Matching private Telegram user ID: ${id}`);
  if (await prompt("To confirm this is YOUR challenge, type that numeric ID: ") !== id) {
    throw new SetupError("Owner confirmation did not match. No binding was changed.");
  }
  console.log(`Verified locally. Put ${id} into TELEGRAM_OWNER_ID using Wrangler's secret prompt. This helper did not store the token, bind a Worker, or send a Telegram message.`);
}

async function registerWebhook(token) {
  const value = await prompt("Deployed HTTPS webhook URL (ending in /telegram): ");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SetupError("Invalid webhook URL.");
  }
  if (
    url.protocol !== "https:" || url.pathname !== "/telegram" ||
    url.username || url.password || url.search || url.hash ||
    url.hostname === "localhost" || !url.hostname.includes(".")
  ) throw new SetupError("Use the intended public HTTPS Worker/custom-domain URL ending in /telegram, without credentials, query or fragment.");
  const current = await telegram(token, "getWebhookInfo");
  if (current.url && current.url !== url.href) {
    throw new SetupError("This bot is bound to a DIFFERENT webhook. Refusing to overwrite it or modify an existing bot.");
  }
  const secret = await prompt("The SAME TELEGRAM_WEBHOOK_SECRET already stored in the Worker (hidden): ", true);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new SetupError("Webhook secret must be 32-256 letters, digits, underscores or hyphens.");
  }
  if (await prompt("Type REGISTER to register this webhook and discard pending setup updates: ") !== "REGISTER") {
    throw new SetupError("Not registered.");
  }
  const result = await telegram(token, "setWebhook", {
    url: url.href,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 1,
    drop_pending_updates: true,
  });
  const verified = await telegram(token, "getWebhookInfo");
  if (result !== true || verified.url !== url.href) {
    throw new SetupError("Webhook registration could not be verified. Inspect configuration before proceeding.");
  }
  console.log("Webhook URL registered and verified. No Telegram sendMessage request was made. /start in your private chat can now verify end-to-end owner binding.");
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["discover", "webhook"].includes(mode)) {
    throw new SetupError("Usage: npm run telegram:setup -- discover | webhook. Never put a token or secret in command arguments.");
  }
  const token = await prompt("Dedicated bot's BotFather token (hidden): ", true);
  if (!/^\d{5,16}:[A-Za-z0-9_-]{20,100}$/.test(token)) {
    throw new SetupError("Token format is invalid.");
  }
  const bot = await telegram(token, "getMe");
  if (!bot?.is_bot || typeof bot.username !== "string" || !/^[A-Za-z0-9_]+$/.test(bot.username)) {
    throw new SetupError("Telegram did not identify a bot username.");
  }
  if (await prompt(`Intended bot is @${bot.username}. Type its username to confirm: `) !== bot.username) {
    throw new SetupError("Bot confirmation did not match. No configuration was changed.");
  }
  if (mode === "discover") await discover(token);
  else await registerWebhook(token);
}

main().catch((error) => {
  console.error(error instanceof SetupError ? error.message : "Setup failed unexpectedly. No sensitive error details are printed.");
  process.exitCode = 1;
});
