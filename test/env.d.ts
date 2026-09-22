import type { D1Migration } from "cloudflare:test";
import type { Env as BotEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends BotEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
