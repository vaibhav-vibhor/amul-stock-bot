import { SafeError } from "./errors";
import type { BackgroundCycle, Catalog, Config, Observation, StoredProduct } from "./types";

type Value = string | number | null;
export type TelegramMethod = "sendMessage" | "editMessageText" | "answerCallbackQuery";
export type OutboxKind = "alert" | "reply" | "callback";

export interface Delivery {
  id: number;
  dedupe_key: string;
  kind: OutboxKind;
  method: TelegramMethod;
  payload: string;
  pincode: string | null;
  product_id: number | null;
  watch_epoch: string | null;
  attempts: number;
  expires_at: number | null;
  scheduled_at: number | null;
}

export interface BackgroundState {
  lease: Lease;
  config: Config;
  products: StoredProduct[];
  latest: BackgroundCycle | null;
  pendingReplies: boolean;
}

const PRODUCTS_SQL = `
  SELECT p.*, t.epoch FROM products p
  LEFT JOIN tracked_products t ON t.product_id = p.id
  WHERE p.active = 1 OR t.product_id IS NOT NULL ORDER BY p.id
`;

export class Store {
  constructor(readonly db: D1Database) {}

  sql(query: string, ...values: Value[]): D1PreparedStatement {
    return this.db.prepare(query).bind(...values);
  }

  async config(): Promise<Config> {
    const config = await this.sql("SELECT * FROM config WHERE id = 1").first<Config>();
    if (!config) throw new SafeError("database_not_migrated");
    return config;
  }

  async products(): Promise<StoredProduct[]> {
    const result = await this.sql(PRODUCTS_SQL).all<StoredProduct>();
    return result.results;
  }

  async observations(): Promise<Observation[]> {
    const result = await this.sql("SELECT * FROM observations").all<Observation>();
    return result.results;
  }

  async lastBackgroundCycle(): Promise<BackgroundCycle | null> {
    return this.sql("SELECT * FROM background_cycles ORDER BY scheduled_at DESC LIMIT 1")
      .first<BackgroundCycle>();
  }

  async processed(id: number, callbackId?: string): Promise<boolean> {
    return Boolean(
      await this.sql(
        "SELECT 1 FROM telegram_updates WHERE update_id = ? OR callback_id = ? LIMIT 1",
        id,
        callbackId ?? null,
      ).first(),
    );
  }

  async pendingProductMenu(revision: number): Promise<{ next_attempt_at: number } | null> {
    return this.sql(
      `SELECT next_attempt_at FROM outbox
       WHERE state = 'pending' AND kind = 'reply'
         AND config_revision = ? AND dedupe_key LIKE 'update:%:menu:%'
       ORDER BY next_attempt_at LIMIT 1`,
      revision,
    ).first<{ next_attempt_at: number }>();
  }

  catalogPlan(catalog: Catalog): D1PreparedStatement[] {
    return [
      this.sql("UPDATE products SET active = 0"),
      ...catalog.products.map((product) =>
        this.sql(
          `INSERT INTO products (alias, name, active, catalog_available, last_seen_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(alias) DO UPDATE SET name = excluded.name, active = 1,
             catalog_available = excluded.catalog_available,
             last_seen_at = excluded.last_seen_at`,
          product.alias,
          product.name,
          product.available,
          catalog.checkedAt,
        ),
      ),
      this.sql(
        "UPDATE config SET catalog_at = ?, upstream_retry_at = 0 WHERE id = 1",
        catalog.checkedAt,
      ),
    ];
  }

  enqueue(
    key: string,
    kind: OutboxKind,
    method: TelegramMethod,
    payload: Record<string, unknown>,
    reminder?: { pincode: string; scheduledAt: number },
    expiresAt?: number,
    revision?: number,
  ): D1PreparedStatement {
    const now = Date.now();
    return this.sql(
      `INSERT INTO outbox
       (dedupe_key, kind, method, payload, pincode,
        created_at, next_attempt_at, expires_at, config_revision, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO NOTHING`,
      key,
      kind,
      method,
      JSON.stringify(payload),
      reminder?.pincode ?? null,
      now,
      now,
      expiresAt ?? null,
      revision ?? null,
      reminder?.scheduledAt ?? null,
    );
  }

  async acquire(): Promise<Lease | null> {
    const token = crypto.randomUUID();
    const row = await this.acquireStatement(token).first<{ token: string }>();
    return row ? new Lease(this, token) : null;
  }

  private acquireStatement(token: string): D1PreparedStatement {
    return this.sql(
      `UPDATE operation_lease SET token = ?, expires_at = unixepoch() + 120
       WHERE id = 1 AND expires_at <= unixepoch() RETURNING token`,
      token,
    );
  }

  async acquireBackground(): Promise<BackgroundState | null> {
    type ReadRow = { token: string } | Config | StoredProduct | BackgroundCycle | { pending: number };
    const token = crypto.randomUUID();
    // One D1 round trip obtains a consistent snapshot after the atomic claim.
    const results = await this.db.batch<ReadRow>([
      this.acquireStatement(token),
      this.sql("SELECT * FROM config WHERE id = 1"),
      this.sql(PRODUCTS_SQL),
      this.sql("SELECT * FROM background_cycles ORDER BY scheduled_at DESC LIMIT 1"),
      this.sql("SELECT EXISTS(SELECT 1 FROM outbox WHERE state = 'pending' AND kind != 'alert') AS pending"),
    ]);
    const claim = results[0]?.results[0];
    if (!claim || !("token" in claim) || claim.token !== token) return null;
    const config = results[1]?.results[0];
    const latest = results[3]?.results[0];
    const pending = results[4]?.results[0];
    if (!config || !("telegram_retry_at" in config) || !pending || !("pending" in pending)) {
      throw new SafeError("database_not_migrated");
    }
    return {
      lease: new Lease(this, token), config,
      products: (results[2]?.results ?? []).filter((row): row is StoredProduct => "alias" in row),
      latest: latest && "scheduled_at" in latest ? latest : null,
      pendingReplies: Boolean(pending.pending),
    };
  }
}

export class Lease {
  constructor(
    readonly store: Store,
    readonly token: string,
  ) {}

  async assertOwned(minimumSeconds = 0): Promise<void> {
    const owned = await this.store.sql(
      `SELECT 1 FROM operation_lease
       WHERE id = 1 AND token = ? AND expires_at > unixepoch() + ?`,
      this.token,
      minimumSeconds,
    ).first();
    if (!owned) throw new SafeError("operation_lease_lost");
  }

  async commit<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
    revision: number | null = null,
    minimumSeconds = 0,
  ): Promise<D1Result<T>[]> {
    if (!statements.length) return [];
    return this.store.db.batch<T>([
      this.store.sql(
        `UPDATE write_guard SET valid = CASE WHEN EXISTS (
           SELECT 1 FROM operation_lease l CROSS JOIN config c
           WHERE l.id = 1 AND c.id = 1 AND l.token = ?
             AND l.expires_at > unixepoch() + ?
             AND (? IS NULL OR c.revision = ?)
         ) THEN 1 ELSE 0 END WHERE id = 1`,
        this.token,
        minimumSeconds,
        revision,
        revision,
      ),
      ...statements,
    ]);
  }

  async release(): Promise<void> {
    await this.store.sql(
      "UPDATE operation_lease SET token = NULL, expires_at = 0 WHERE id = 1 AND token = ?",
      this.token,
    ).run();
  }
}
