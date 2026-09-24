import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { PersonalMonitor } from "../src";
import { CHECK_INTERVAL_MS, MONITOR_CRON } from "../src/background";
import type { Env } from "../src/types";

it("keeps the checked-in JSONC schedule and Free SQLite binding aligned with the runtime", () => {
  const monitorBinding: keyof Env = "MONITOR";
  expect(MONITOR_CRON).toBe("*/5 * * * *");
  expect(CHECK_INTERVAL_MS).toBe(5 * 60_000);
  expect(env.TEST_WRANGLER_CONFIG).toMatchObject({
    triggers: { crons: [MONITOR_CRON] },
    durable_objects: { bindings: [{ name: monitorBinding, class_name: PersonalMonitor.name }] },
    migrations: [{ tag: expect.any(String), new_sqlite_classes: [PersonalMonitor.name] }],
  });
});

it("keeps the checked-in template disabled and explicitly unconfigured rather than bound to a real account", () => {
  const databaseBinding: keyof Env = "DB";
  expect(env.TEST_WRANGLER_CONFIG).toMatchObject({
    vars: { MONITORING_ENABLED: "false" },
    d1_databases: [{
      binding: databaseBinding,
      database_name: "amul-stock-bot",
      database_id: expect.stringMatching(/^SETUP_REQUIRED_[A-Z0-9_]+$/),
      migrations_dir: "migrations",
    }],
  });
  expect(env.TEST_WRANGLER_CONFIG.vars).toEqual({ MONITORING_ENABLED: "false" });
  expect(env.TEST_WRANGLER_CONFIG).not.toHaveProperty("account_id");
});
