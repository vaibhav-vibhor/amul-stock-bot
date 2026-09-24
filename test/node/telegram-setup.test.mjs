import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prompt, runSetup } from "../../scripts/telegram-setup.mjs";

const TOKEN = "123456:FAKE_OFFLINE_TOKEN_NOT_A_REAL_CREDENTIAL";
const SECRET = "FAKE_OFFLINE_WEBHOOK_SECRET_NOT_A_CREDENTIAL";
const BOT = "FixtureProteinBot";
const OWNER = 123456789;
const WEBHOOK_URL = "https://fixture.example/telegram";
const NOW = Date.parse("2026-09-24T10:00:00Z");

function harness(t) {
  const cwd = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "amul-setup-test-"));
  process.chdir(directory);
  t.after(() => {
    process.chdir(cwd);
    rmSync(directory, { recursive: true, force: true });
  });
  const calls = [];
  const questions = [];
  const logs = [];
  let terminal = "";
  const state = { now: NOW, webhook: "", answers: [], updates: null, failMethod: null };
  t.mock.method(Date, "now", () => state.now);
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  const challenge = () => {
    const value = logs.join("\n").match(/\/bind [a-f0-9]{32}/)?.[0];
    assert.ok(value, "The helper must emit its actual random challenge.");
    return value;
  };
  const update = (owner = OWNER, changes = {}) => ({
    message: {
      text: challenge(), date: Math.floor(state.now / 1_000),
      from: { id: owner, is_bot: false }, chat: { id: owner, type: "private" },
      ...changes,
    },
  });
  t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.ok(String(input).startsWith(`https://api.telegram.org/bot${TOKEN}/`));
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    const method = String(input).split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === state.failMethod) {
      throw new Error(`Private transport detail: ${TOKEN}; ${SECRET}`);
    }
    let result;
    if (method === "getMe") result = { is_bot: true, username: BOT };
    else if (method === "getWebhookInfo") result = { url: state.webhook };
    else if (method === "getUpdates") result = state.updates ? state.updates() : [update()];
    else if (method === "setWebhook") {
      state.webhook = body.url;
      result = true;
    } else assert.fail(`Unexpected Telegram method: ${method}`);
    return Response.json({ ok: true, result });
  });
  const ask = async (label, secret = false) => {
    questions.push({ label, secret });
    assert.ok(state.answers.length, "Unexpected extra setup prompt.");
    const next = state.answers.shift();
    const answer = typeof next === "function" ? next() : next;
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new Writable({
      write(chunk, _encoding, done) {
        terminal += chunk.toString();
        done();
      },
    }), { isTTY: true, columns: 120 });
    try {
      const pending = prompt(label, secret, { stdin, stdout });
      setImmediate(() => {
        if (typeof answer === "object") {
          stdin.write(answer.text);
          if (answer.end) stdin.end();
        } else stdin.write(`${answer}\n`);
      });
      return await pending;
    } finally {
      stdin.destroy();
      stdout.end();
    }
  };
  return {
    state, calls, questions, update,
    output: () => [...logs, terminal].join("\n"),
    async run(mode, answers) {
      calls.length = 0;
      questions.length = 0;
      logs.length = 0;
      terminal = "";
      state.answers = [...answers];
      return runSetup([mode], ask);
    },
    assertPrivate() {
      const output = [...logs, terminal].join("\n");
      assert.ok(!output.includes(TOKEN), "Token leaked through terminal/log output.");
      assert.ok(!output.includes(SECRET), "Webhook secret leaked through terminal/log output.");
      assert.deepEqual(readdirSync(directory), [], "Setup must not write credentials or files.");
    },
    directory,
  };
}

test("discovers the owner using real masked prompts and a private challenge without mutation or credential files", async (t) => {
  const h = harness(t);
  assert.equal(await h.run("discover", [TOKEN, BOT, "", String(OWNER)]), 0);
  assert.deepEqual(h.calls.map((call) => call.method), ["getMe", "getWebhookInfo", "getUpdates"]);
  assert.deepEqual(h.calls.at(-1).body, { timeout: 0, limit: 100, allowed_updates: ["message"] });
  assert.deepEqual(h.questions.map((question) => question.secret), [true, false, false, false]);
  assert.match(h.output(), /Verified locally/);
  assert.ok(h.output().includes(String(OWNER)));
  assert.ok(h.output().includes(BOT), "Non-secret confirmation still echoes normally.");
  h.assertPrivate();
});

test("refuses an existing webhook and mismatched bot or owner confirmation", async (t) => {
  const h = harness(t);
  for (const scenario of [
    { webhook: WEBHOOK_URL, answers: [TOKEN, BOT], error: /already has a webhook/ },
    { webhook: "", answers: [TOKEN, "WrongBot"], error: /Bot confirmation did not match/ },
    { webhook: "", answers: [TOKEN, BOT, "", "987654321"], error: /Owner confirmation did not match/ },
  ]) {
    h.state.webhook = scenario.webhook;
    assert.equal(await h.run("discover", scenario.answers), 1);
    assert.match(h.output(), scenario.error);
    assert.ok(h.calls.every((call) => call.method.startsWith("get")));
    assert.equal(h.state.webhook, scenario.webhook);
    h.assertPrivate();
  }
});

test("rejects expired, wrong, non-private and nonunique ownership challenges", async (t) => {
  const h = harness(t);
  for (const kind of ["expired-before", "expired-after", "wrong", "group", "mismatched-chat", "nonunique"]) {
    h.state.now = NOW;
    h.state.updates = () => {
      if (kind === "expired-after") h.state.now += 301_000;
      if (kind === "wrong") return [h.update(OWNER, { text: "/bind wrong-challenge" })];
      if (kind === "group") return [h.update(OWNER, { chat: { id: OWNER, type: "group" } })];
      if (kind === "mismatched-chat") return [h.update(OWNER, { chat: { id: OWNER + 1, type: "private" } })];
      if (kind === "nonunique") return [h.update(), h.update(OWNER + 1)];
      return [h.update()];
    };
    const sent = () => {
      if (kind === "expired-before") h.state.now += 301_000;
      return "";
    };
    assert.equal(await h.run("discover", [TOKEN, BOT, sent]), 1, kind);
    assert.match(h.output(), kind.startsWith("expired") ? /challenge expired/ : /No unique matching private challenge/);
    assert.equal(h.questions.length, 3, "Invalid discovery must never ask to bind an owner.");
    assert.ok(h.calls.every((call) => call.method.startsWith("get")));
    h.assertPrivate();
  }
});

test("never replaces a different webhook and requires exact REGISTER consent", async (t) => {
  const h = harness(t);
  h.state.webhook = "https://other.example/telegram";
  assert.equal(await h.run("webhook", [TOKEN, BOT, WEBHOOK_URL]), 1);
  assert.match(h.output(), /DIFFERENT webhook/);
  assert.equal(h.questions.length, 3, "Refuse the different webhook before asking for its secret.");
  assert.ok(!h.calls.some((call) => call.method === "setWebhook"));
  h.assertPrivate();

  h.state.webhook = WEBHOOK_URL;
  assert.equal(await h.run("webhook", [TOKEN, BOT, WEBHOOK_URL, SECRET, "register"]), 1);
  assert.match(h.output(), /Not registered/);
  assert.ok(!h.calls.some((call) => call.method === "setWebhook"));
  assert.equal(h.state.webhook, WEBHOOK_URL);
  h.assertPrivate();
});

test("registers and verifies the intended webhook only after explicit consent with both secrets masked", async (t) => {
  const h = harness(t);
  assert.equal(await h.run("webhook", [TOKEN, BOT, WEBHOOK_URL, SECRET, "REGISTER"]), 0);
  assert.deepEqual(h.calls.map((call) => call.method), ["getMe", "getWebhookInfo", "setWebhook", "getWebhookInfo"]);
  assert.deepEqual(h.calls[2].body, {
    url: WEBHOOK_URL, secret_token: SECRET, allowed_updates: ["message", "callback_query"],
    max_connections: 1, drop_pending_updates: true,
  });
  assert.deepEqual(h.questions.map((question) => question.secret), [true, false, false, true, false]);
  assert.match(h.output(), /Webhook URL registered and verified/);
  assert.ok(!h.calls.some((call) => call.method === "sendMessage"));
  h.assertPrivate();
});

test("keeps TTY enforcement and sanitizes transport errors, cancellation, closed input and unexpected failures", async (t) => {
  const h = harness(t);
  const cli = fileURLToPath(new URL("../../scripts/telegram-setup.mjs", import.meta.url));
  const noTerminal = spawnSync(process.execPath, [cli, "discover"], {
    cwd: h.directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
  });
  assert.equal(noTerminal.status, 1);
  assert.match(noTerminal.stderr, /interactive terminal/);
  assert.equal(h.calls.length, 0);

  h.state.failMethod = "setWebhook";
  assert.equal(await h.run("webhook", [TOKEN, BOT, WEBHOOK_URL, SECRET, "REGISTER"]), 1);
  assert.match(h.output(), /Telegram network\/response failure/);
  h.assertPrivate();
  h.state.failMethod = null;

  for (const [input, error] of [
    [{ text: `${TOKEN}\x03` }, /Cancelled/],
    [{ text: TOKEN, end: true }, /Terminal input closed/],
    [() => { throw new Error(`${TOKEN}; ${SECRET}`); }, /Setup failed unexpectedly/],
  ]) {
    assert.equal(await h.run("discover", [input]), 1);
    assert.match(h.output(), error);
    assert.equal(h.calls.length, 0);
    h.assertPrivate();
  }
});
