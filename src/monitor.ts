import { DurableObject } from "cloudflare:workers";
import bot from "./bot";
import type { Env } from "./types";

export const MONITOR_NAME = "personal-monitor";

export class PersonalMonitor extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    console.log(JSON.stringify({ operation: "monitor_request", type: "webhook" }));
    return bot.fetch(request, this.env);
  }

  async runScheduled(scheduledTime: number, cron: string): Promise<{ ok: true } | { ok: false; error: "scheduled_check_failed" }> {
    console.log(JSON.stringify({ operation: "monitor_request", type: "scheduled", scheduledTime }));
    try {
      await bot.scheduled({ scheduledTime, cron }, this.env);
      return { ok: true };
    } catch {
      // The core handler already emitted a sanitized failure. Return it
      // explicitly so the cron caller can fail without forwarding a raw stack.
      return { ok: false, error: "scheduled_check_failed" };
    }
  }
}
