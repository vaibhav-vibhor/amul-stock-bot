export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_OWNER_ID: string;
}

export type Availability = 0 | 1;

export interface Product {
  alias: string;
  name: string;
  available: Availability | null;
}

export interface Catalog {
  pincode: string;
  region: string;
  products: Product[];
  checkedAt: number;
}

export interface Config {
  id: number;
  pincode: string;
  revision: number;
  paused: number;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  catalog_at: number | null;
  upstream_retry_at: number;
  telegram_retry_at: number;
}

export interface StoredProduct {
  id: number;
  alias: string;
  name: string;
  active: number;
  catalog_available: Availability | null;
  last_seen_at: number;
  epoch: string | null;
}

export interface Observation {
  product_id: number;
  pincode: string;
  watch_epoch: string;
  available: Availability;
  checked_at: number;
  transition_seq: number;
}

export interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface Message {
  text: string;
  reply_markup?: { inline_keyboard: Button[][] };
}

export interface OwnerUpdate {
  id: number;
  text?: string;
  callback?: { id: string; data: string; messageId: number };
}
