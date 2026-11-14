import * as z from "zod";
import type { MediaMetering } from "./media-operation-contract.js";
import { MediaBillingRefusal } from "./execution-error.js";

/** The Durable Object storage slice the meter owns tables in. */
export type DailyMediaMeterStorage = Readonly<{
  /** SQLite access owned by the Durable Object. */
  sql: Readonly<{
    /** Run one statement with positional bindings. */
    exec: (
      query: string,
      ...bindings: readonly (string | number)[]
    ) => Readonly<{
      /** Read every returned row. */
      toArray: () => readonly unknown[];
    }>;
  }>;
  /** Run the body in one synchronous transaction. */
  transactionSync: <T>(body: () => T) => T;
}>;

/** RPC surface of the Durable Object that owns one Oyster's daily media total. */
export type DailyMediaMeterPort = Readonly<{
  /** Hold one generation's provider cost against today's limit; false when it would exceed it. */
  dailyAdmit: (
    input: Readonly<{
      operationId: string;
      costMilliunits: number;
      limitMilliunits: number;
    }>,
  ) => Promise<boolean> | boolean;
  /** Release the hold when nothing was delivered, or keep it once delivered. */
  dailySettle: (
    input: Readonly<{ operationId: string; delivered: boolean }>,
  ) => Promise<void> | void;
}>;

const totalRowSchema = z.strictObject({ total: z.number() });

const MS_PER_DAY = 86_400_000;

/** The UTC day number a timestamp falls in; the total resets when it changes. */
function utcDay(timestamp: number): number {
  return Math.floor(timestamp / MS_PER_DAY);
}

/**
 * A UTC-day total of admitted media cost, kept in one Durable Object's SQLite.
 * Every statement runs inside one synchronous transaction, so two concurrent
 * admits near the limit are serialized by the object and cannot both pass.
 * Holds are keyed by the durable operation id, so a retried admit never counts
 * twice. A hold that is never settled stays counted until its day ends.
 */
export class DailyMediaMeter {
  private ready = false;
  constructor(
    private readonly storage: DailyMediaMeterStorage,
    private readonly now: () => number = Date.now,
  ) {}

  private ensureSchema(): void {
    if (this.ready) return;
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS daily_media_hold (operation_id TEXT PRIMARY KEY, day INTEGER NOT NULL, milliunits INTEGER NOT NULL CHECK(milliunits>=0)) STRICT",
    );
    this.ready = true;
  }

  /** Hold `costMilliunits` for this operation unless the day's total would exceed the limit. */
  admit(
    input: Readonly<{
      operationId: string;
      costMilliunits: number;
      limitMilliunits: number;
    }>,
  ): boolean {
    return this.storage.transactionSync(() => {
      this.ensureSchema();
      const day = utcDay(this.now());
      const { sql } = this.storage;
      sql.exec("DELETE FROM daily_media_hold WHERE day < ?", day);
      const held = sql
        .exec(
          "SELECT day FROM daily_media_hold WHERE operation_id = ?",
          input.operationId,
        )
        .toArray()[0];
      if (held !== undefined) return true;
      const { total } = totalRowSchema.parse(
        sql
          .exec(
            "SELECT COALESCE(SUM(milliunits),0) AS total FROM daily_media_hold WHERE day = ?",
            day,
          )
          .toArray()[0],
      );
      if (total + input.costMilliunits > input.limitMilliunits) return false;
      sql.exec(
        "INSERT INTO daily_media_hold (operation_id, day, milliunits) VALUES (?, ?, ?)",
        input.operationId,
        day,
        input.costMilliunits,
      );
      return true;
    });
  }

  /** Keep the hold when media was delivered; release it when nothing was. */
  settle(input: Readonly<{ operationId: string; delivered: boolean }>): void {
    if (input.delivered) return;
    this.storage.transactionSync(() => {
      this.ensureSchema();
      this.storage.sql.exec(
        "DELETE FROM daily_media_hold WHERE operation_id = ?",
        input.operationId,
      );
    });
  }
}

/** `MediaMetering` that enforces one exact daily limit through the owning object. */
export function createDailyMediaMetering(
  meter: DailyMediaMeterPort,
  limitMilliunits: number,
): MediaMetering {
  return {
    admit: async (input) => {
      const admitted = await meter.dailyAdmit({
        operationId: input.operationId,
        costMilliunits: input.providerCostMilliunits,
        limitMilliunits,
      });
      if (!admitted) throw new MediaBillingRefusal("daily_limit_reached");
      return { priceMilliunits: input.providerCostMilliunits };
    },
    settle: async (input) => {
      await meter.dailySettle({
        operationId: input.operationId,
        delivered: input.units > 0,
      });
    },
  };
}
