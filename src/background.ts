import type { BackgroundState } from "./db";
import { SafeError } from "./errors";
import type { Network } from "./http";
import { availabilityReminder, planCheck } from "./stock";
import type { BackgroundCycle, Env } from "./types";

export const MONITOR_CRON = "*/5 * * * *";
export const CHECK_INTERVAL_MS = 5 * 60_000;

export async function checkBackground(
  controller: Pick<ScheduledController, "scheduledTime" | "cron">,
  env: Env,
  state: BackgroundState,
  network: Network,
): Promise<void> {
  if (!Number.isSafeInteger(controller.scheduledTime) || controller.scheduledTime < 0 ||
      controller.cron !== MONITOR_CRON || controller.scheduledTime > Date.now() + 60_000) {
    throw new SafeError("invalid_scheduled_cycle");
  }
  const scheduledAt = Math.floor(controller.scheduledTime / CHECK_INTERVAL_MS) * CHECK_INTERVAL_MS;
  const { lease, config, latest } = state;
  const store = lease.store;
  if (latest && latest.scheduled_at > scheduledAt) return;
  if (latest?.scheduled_at === scheduledAt && latest.completed_at !== null) return;
  const expiresAt = scheduledAt + CHECK_INTERVAL_MS;
  await lease.commit([
    store.sql(
      `UPDATE outbox SET state = 'cancelled', last_error = 'superseded_cycle'
       WHERE kind = 'alert' AND state = 'pending'
         AND (scheduled_at IS NULL OR scheduled_at < ?)`,
      scheduledAt,
    ),
    store.sql(
      `INSERT INTO background_cycles
       (scheduled_at, started_at, pincode, config_revision, outcome)
       VALUES (?, ?, ?, ?, 'checking') ON CONFLICT(scheduled_at) DO NOTHING`,
      scheduledAt, Date.now(), config.pincode, config.revision,
    ),
  ], config.revision);

  const statements: D1PreparedStatement[] = [];
  let outcome: BackgroundCycle["outcome"];
  let selectedCount = 0;
  let availableCount = 0;
  let unknownCount = 0;
  let error: string | null = null;
  if (Date.now() >= expiresAt) {
    outcome = "expired";
  } else if (config.paused) {
    outcome = "paused";
  } else {
    const plan = await planCheck(store, config, network, false, state.products);
    selectedCount = plan.selectedCount;
    unknownCount = plan.unknownCount;
    availableCount = plan.snapshot.filter((product) => product.available === 1).length;
    error = plan.error;
    statements.push(...plan.statements);
    outcome = Date.now() >= expiresAt ? "expired"
      : plan.error ? "error"
      : !selectedCount ? "empty"
      : unknownCount ? "partial"
      : availableCount ? "available" : "unavailable";
    if (availableCount && plan.checkedAt !== null && outcome !== "expired") {
      const message = availabilityReminder(config.pincode, plan.checkedAt, plan.snapshot, unknownCount);
      statements.push(store.enqueue(
        `reminder:${scheduledAt}`, "alert", "sendMessage",
        { chat_id: env.TELEGRAM_OWNER_ID, ...message, link_preview_options: { is_disabled: true } },
        { pincode: config.pincode, scheduledAt }, expiresAt, config.revision,
      ));
    }
  }
  statements.push(
    store.sql(
      `UPDATE background_cycles SET completed_at = ?, pincode = ?, config_revision = ?,
       outcome = ?, selected_count = ?, available_count = ?, unknown_count = ?, error = ?
       WHERE scheduled_at = ?`,
      Date.now(), config.pincode, config.revision,
      outcome, selectedCount, availableCount, unknownCount, error, scheduledAt,
    ),
    store.sql(
      `DELETE FROM background_cycles WHERE scheduled_at IN (
         SELECT b.scheduled_at FROM background_cycles b
         WHERE b.scheduled_at < ? AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.scheduled_at = b.scheduled_at)
         ORDER BY b.scheduled_at LIMIT 100
       )`,
      Date.now() - 30 * 86_400_000,
    ),
  );
  await lease.commit(statements, config.revision);
  console.log(JSON.stringify({
    operation: "background_cycle", scheduledAt, outcome,
    selectedCount, availableCount, unknownCount, error,
  }));
}
