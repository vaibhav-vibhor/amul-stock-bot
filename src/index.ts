import { MONITOR_NAME } from "./monitor";
import type { Env } from "./types";

export { PersonalMonitor } from "./monitor";
export { MAX_WEBHOOK_BYTES } from "./bot";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return new Response("ok (liveness only)");
    }
    if (path !== "/telegram" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    try {
      return await env.MONITOR.getByName(MONITOR_NAME).fetch(request);
    } catch {
      console.error(JSON.stringify({ operation: "monitor_dispatch", error: "durable_object_unavailable" }));
      return new Response("Request could not be processed; retry", { status: 503 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (env.MONITORING_ENABLED !== "true") return;
    try {
      const result = await env.MONITOR.getByName(MONITOR_NAME).runScheduled(controller.scheduledTime, controller.cron);
      if (!result.ok) throw new Error(result.error);
      console.log(JSON.stringify({ operation: "cron_dispatched", scheduledTime: controller.scheduledTime }));
    } catch {
      console.error(JSON.stringify({ operation: "monitor_dispatch", error: "durable_object_cycle_failed" }));
      throw new Error("Scheduled check failed; inspect sanitized application logs.");
    }
  },
} satisfies ExportedHandler<Env>;
