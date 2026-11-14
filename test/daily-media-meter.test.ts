import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import {
  createDailyMediaMetering,
  DailyMediaMeter,
  type DailyMediaMeterPort,
} from "../src/daily-media-meter.js";
import { executeMediaOperation } from "../src/media-operation.js";
import { MediaBillingRefusal } from "../src/execution-error.js";
import type { MediaOperationRequest } from "../src/media-operation-owner.js";
import { mediaOperationFixture as fixture } from "./fixtures/media-operation.fixture.js";

const DAY = 86_400_000;
const request: MediaOperationRequest = {
  model: "@cf/black-forest-labs/flux-2-klein-4b",
  prompt: "a quiet greenhouse",
  width: 1_024,
  height: 768,
  computerId: "computer-a",
  path: "generated/greenhouse.png",
};
const png = () =>
  Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), format: "png" });

/** The Durable Object's RPC surface over a real SQLite database and a movable clock. */
function meterFixture(start = 10 * DAY + 5_000) {
  const test = fixture();
  let now = start;
  const meter = new DailyMediaMeter(test.storage, () => now);
  const port: DailyMediaMeterPort = {
    dailyAdmit: (input) => Promise.resolve(meter.admit(input)),
    dailySettle: (input) => {
      meter.settle(input);
      return Promise.resolve();
    },
  };
  return {
    test,
    port,
    meter,
    advance: (ms: number) => {
      now += ms;
    },
    at: (timestamp: number) => {
      now = timestamp;
    },
  };
}

function execute(
  owner: ReturnType<typeof fixture>["owner"],
  requestId: string,
  metering: ReturnType<typeof createDailyMediaMetering>,
  run: () => Promise<{ bytes: Uint8Array; format: string }>,
) {
  return Effect.runPromise(
    executeMediaOperation({
      operation: owner,
      actorUserId: "actor-a",
      coordinates: { namespace: "oyster", owner: "prints" },
      requestId,
      request,
      metering,
      destination: {
        authorize: () => Promise.resolve(),
        write: () => Promise.resolve(),
      },
      generation: {
        prepare: () =>
          Promise.resolve({ costMilliunits: 600, references: [], run }),
      },
    }),
  );
}

describe("daily media limit", () => {
  it("admits up to the limit, refuses beyond it, and keeps the total exact", async () => {
    const { port, test } = meterFixture();
    const metering = createDailyMediaMetering(port, 1_000);
    const admit = (operationId: string, providerCostMilliunits: number) =>
      metering.admit({
        operationId,
        model: "m",
        unit: "image",
        units: 1,
        providerCostMilliunits,
      });
    await expect(admit("a", 600)).resolves.toEqual({ priceMilliunits: 600 });
    await expect(admit("b", 401)).rejects.toMatchObject({
      code: "daily_limit_reached",
    });
    // The refusal held nothing: exactly the remainder is still available.
    await expect(admit("b", 400)).resolves.toEqual({ priceMilliunits: 400 });
    // A retried admit of the same operation never counts twice.
    await expect(admit("a", 600)).resolves.toEqual({ priceMilliunits: 600 });
    await expect(admit("c", 1)).rejects.toBeInstanceOf(MediaBillingRefusal);
    test.close();
  });

  it("lets only one of two concurrent admits near the limit pass", async () => {
    const { port, test } = meterFixture();
    const metering = createDailyMediaMetering(port, 1_000);
    const admit = (operationId: string) =>
      metering.admit({
        operationId,
        model: "m",
        unit: "image",
        units: 1,
        providerCostMilliunits: 600,
      });
    const results = await Promise.allSettled([admit("a"), admit("b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    test.close();
  });

  it("releases a hold on settle(0) and keeps it once delivered", async () => {
    const { port, test } = meterFixture();
    const metering = createDailyMediaMetering(port, 1_000);
    const admit = (operationId: string, cost: number) =>
      metering.admit({
        operationId,
        model: "m",
        unit: "image",
        units: 1,
        providerCostMilliunits: cost,
      });
    await admit("a", 700);
    await metering.settle({ operationId: "a", units: 0 });
    await expect(admit("b", 1_000)).resolves.toBeDefined();
    await metering.settle({ operationId: "b", units: 1 });
    await expect(admit("c", 1)).rejects.toMatchObject({
      code: "daily_limit_reached",
    });
    test.close();
  });

  it("starts a new total at 00:00 UTC", async () => {
    const { port, test, at } = meterFixture();
    const metering = createDailyMediaMetering(port, 1_000);
    const admit = (operationId: string) =>
      metering.admit({
        operationId,
        model: "m",
        unit: "image",
        units: 1,
        providerCostMilliunits: 1_000,
      });
    at(11 * DAY - 1);
    await admit("a");
    await expect(admit("b")).rejects.toMatchObject({
      code: "daily_limit_reached",
    });
    at(11 * DAY);
    await expect(admit("b")).resolves.toBeDefined();
    test.close();
  });

  it("refuses before any provider dispatch, then releases a failed run's hold", async () => {
    const { port, test } = meterFixture();
    const metering = createDailyMediaMetering(port, 1_000);
    const run = vi.fn(png);
    await execute(test.owner, "request-a", metering, run);
    expect(run).toHaveBeenCalledOnce();
    // 600 delivered; a second 600 would pass 1,000, so nothing is dispatched.
    const second = fixture(
      ":memory:",
      new Map(),
      undefined,
      "media-operation-b",
    );
    const refused = vi.fn(png);
    await expect(
      execute(second.owner, "request-b", metering, refused),
    ).rejects.toThrow("Media billing failed");
    expect(refused).not.toHaveBeenCalled();
    // A provider failure delivers nothing, so its hold is released.
    const third = fixture(
      ":memory:",
      new Map(),
      undefined,
      "media-operation-c",
    );
    const meter = createDailyMediaMetering(port, 1_200);
    const failing = vi.fn(() => Promise.reject(new Error("provider down")));
    await expect(
      execute(third.owner, "request-c", meter, failing),
    ).rejects.toThrow();
    const fourth = fixture(
      ":memory:",
      new Map(),
      undefined,
      "media-operation-d",
    );
    await expect(
      execute(fourth.owner, "request-d", meter, vi.fn(png)),
    ).resolves.toMatchObject({ kind: "succeeded" });
    for (const each of [test, second, third, fourth]) each.close();
  });
});
