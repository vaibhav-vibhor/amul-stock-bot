import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          TELEGRAM_BOT_TOKEN: "123456:FAKE_TEST_TOKEN_NOT_A_REAL_CREDENTIAL",
          TELEGRAM_WEBHOOK_SECRET: "FAKE_TEST_WEBHOOK_SECRET_NOT_A_REAL_SECRET",
          TELEGRAM_OWNER_ID: "123456789",
          MONITORING_ENABLED: "true",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
}));
