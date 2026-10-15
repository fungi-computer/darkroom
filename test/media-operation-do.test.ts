import sharp from "sharp";
import * as Effect from "effect/Effect";
import { executeMediaOperation } from "../src/media-operation.js";
import type { MediaMetering } from "../src/media-operation-contract.js";
import { MediaBillingRefusal } from "../src/execution-error.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaOperationFixture as fixture } from "./fixtures/media-operation.fixture.js";
import {
  MediaOperationOwner,
  type MediaOperationCoordinates,
  type MediaOperationRequest,
} from "../src/media-operation-owner.js";
import type { MediaReferenceBytes } from "../src/index.js";
import { createMediaService } from "../src/server.js";
import { createWorkersAiMediaProvider } from "../src/cloudflare/provider.js";
import { readMediaFailure } from "../src/browser-failure.js";

const coordinates: MediaOperationCoordinates = {
  namespace: "team-a",
  owner: "installation-a",
};
const request: MediaOperationRequest = {
  model: "@cf/black-forest-labs/flux-2-klein-4b",
  prompt: "a quiet greenhouse",
  width: 1_024,
  height: 768,
  computerId: "computer-a",
  path: "generated/greenhouse.png",
};
const generatedBytes = new Uint8Array([1, 2, 3]);
const refusalMessages = {
  insufficient_credits: "Your studio balance needs a refill.",
  daily_limit_reached: "Your studio is done for today.",
  denied: "Your studio does not allow this purchase.",
};

function admit(owner: MediaOperationOwner, requestId = "request-a") {
  return owner.admit("actor-a", coordinates, requestId, request);
}

type ClaimedLease = Readonly<{ leaseId: string }>;

async function claim(owner: MediaOperationOwner): Promise<ClaimedLease> {
  const result = await owner.claim();
  expect(result.kind).toBe("claimed");
  if (result.kind !== "claimed" || result.leaseId === undefined)
    throw new Error("claim failed");
  return { leaseId: result.leaseId };
}

async function reachCharging(owner: MediaOperationOwner) {
  const claimed = await claim(owner);
  owner.recordEstimate(claimed.leaseId, 125);
  await owner.recordGenerated(claimed.leaseId, generatedBytes, "png");
  owner.recordWritten(claimed.leaseId, "computer-receipt", {
    bytes: 3,
    format: "png",
  });
  return claimed.leaseId;
}

function execute(
  owner: MediaOperationOwner,
  requestId: string,
  run: (signal?: AbortSignal) => Promise<{ bytes: Uint8Array; format: string }>,
  write: (bytes: Uint8Array) => Promise<void>,
  signal?: AbortSignal,
  metering: MediaMetering | "unmetered" = "unmetered",
) {
  const execution = {
    operation: owner,
    actorUserId: "actor-a",
    coordinates,
    requestId,
    request,
    metering,
    destination: { authorize: () => Promise.resolve(), write },
    generation: {
      prepare: () =>
        Promise.resolve({ costMilliunits: 125, references: [], run }),
    },
  };
  return Effect.runPromise(
    signal === undefined
      ? executeMediaOperation(execution)
      : executeMediaOperation({ ...execution, signal }),
  );
}

describe("MediaOperationOwner internal durable owner", () => {
  it("refuses an old disposable schema instead of adding the new refusal fact", async () => {
    const test = fixture();
    await Promise.resolve();
    test.storage.sql.exec("DROP TABLE hub_media_provider_refusal");
    let initialization: Promise<void> = Promise.resolve();
    const owner = new MediaOperationOwner(
      {
        ...test.context,
        blockConcurrencyWhile: <T>(body: () => T | Promise<T>) => {
          const task = Promise.resolve().then(body);
          initialization = task.then(() => undefined);
          return task;
        },
      },
      { APP_ARTIFACTS: test.bucket },
    );
    try {
      await expect(initialization).rejects.toThrow(
        "no such table: hub_media_provider_refusal",
      );
      expect(() => owner.read()).toThrow(
        "no such table: hub_media_provider_refusal",
      );
    } finally {
      test.close();
    }
  });

  it("exposes host namespace and owner while preserving the stored columns", async () => {
    const test = fixture();
    await Promise.resolve();
    try {
      const decision = test.owner.admit(
        "actor-a",
        { namespace: "studio", owner: "illustrator" },
        "request-a",
        request,
      );
      expect(decision.operation).toMatchObject({
        namespace: "studio",
        owner: "illustrator",
      });
      expect(decision.operation).not.toHaveProperty("teamId");
      expect(decision.operation).not.toHaveProperty("installationId");
      expect(
        test.storage.sql
          .exec("SELECT team_id,installation_id FROM hub_media_operation")
          .toArray(),
      ).toEqual([{ team_id: "studio", installation_id: "illustrator" }]);
    } finally {
      test.close();
    }
  });

  it("renders the host's billing refusal without dispatching a provider", async () => {
    const test = fixture();
    const provider = vi.fn(() =>
      Promise.resolve({ bytes: generatedBytes, format: "png" }),
    );
    const write = vi.fn(() => Promise.resolve());
    try {
      const service = createMediaService({
        scope: {
          actorId: "actor-a",
          namespace: "studio",
          owner: "illustrator",
          destinationId: "computer-a",
        },
        operations: { getByName: () => test.owner },
        provider,
        metering: {
          admit: () =>
            Promise.reject(new MediaBillingRefusal("insufficient_credits")),
          settle: () => Promise.resolve(),
        },
        refusalMessages,
        destination: { authorize: () => Promise.resolve(), write },
      });
      const response = await service.request("/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "request-a",
        },
        body: JSON.stringify({
          path: request.path,
          settings: {
            model: request.model,
            prompt: request.prompt,
            width: request.width,
            height: request.height,
          },
        }),
      });
      expect(response.status).toBe(402);
      expect(await response.json()).toMatchObject({
        error: "Your studio balance needs a refill.",
        code: "INSUFFICIENT_CREDIT",
        retryable: false,
      });
      expect(provider).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      test.close();
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => vi.useRealTimers());

  it("erases only the namespace's named operation through its owner and reads back", async () => {
    const test = fixture(":memory:", new Map(), undefined, "media:request-a");
    try {
      admit(test.owner);
      expect(() =>
        test.owner.preflightErasure("another-team", "request-a"),
      ).toThrow("scope mismatch");
      expect(test.owner.preflightErasure("team-a", "request-a")).toMatchObject({
        erased: false,
      });
      expect(await test.owner.erase("team-a", "request-a")).toEqual({
        clear: true,
      });
      expect(await test.owner.erase("team-a", "request-a")).toEqual({
        clear: true,
      });
      expect(await test.owner.readErasure()).toEqual({ clear: true });
      expect(test.owner.read()).toBeNull();
      expect(() => admit(test.owner)).toThrow();
    } finally {
      test.close();
    }
  });

  it("holds an active generation and removes its retained R2 output after completion", async () => {
    const outputs = new Map<string, Uint8Array>();
    const test = fixture(":memory:", outputs, undefined, "media:request-a");
    try {
      admit(test.owner);
      const lease = await claim(test.owner);
      test.owner.recordEstimate(lease.leaseId, 125);
      await test.owner.recordGenerated(lease.leaseId, generatedBytes, "png");
      expect(() => test.owner.preflightErasure("team-a", "request-a")).toThrow(
        "still active",
      );
      test.owner.recordWritten(lease.leaseId, "computer-receipt", {
        bytes: 3,
        format: "png",
      });
      test.owner.recordSucceeded(lease.leaseId, {
        generationId: "media:request-a",
        bytes: 3,
        format: "png",
        costMilliunits: 125,
      });
      expect(outputs.has("media-output/v1/media:request-a")).toBe(true);
      expect((await test.owner.erase("team-a", "request-a")).clear).toBe(true);
      expect(outputs.size).toBe(0);
    } finally {
      test.close();
    }
  });

  it("persists immutable coordinates, replays exact requests, and sanitizes projection", () => {
    const test = fixture();
    const admitted = admit(test.owner);
    expect(admitted.kind).toBe("admitted");
    expect(admitted.operation).toMatchObject({
      operationId: "media-operation-a",
      requestId: "request-a",
      namespace: "team-a",
      owner: "installation-a",
      state: "admitted",
    });
    expect(admitted.operation).not.toHaveProperty("actorUserId");
    expect(admitted.operation).not.toHaveProperty("input");
    expect(admitted.operation).not.toHaveProperty("leaseId");
    expect(admitted.operation).not.toHaveProperty("writeReceipt");
    expect(
      test.owner.admit("actor-a", coordinates, "request-a", {
        ...request,
        prompt: "a quiet greenhouse",
      }).kind,
    ).toBe("replayed");
    expect(
      test.owner.admit("actor-a", coordinates, "request-a", {
        ...request,
        steps: 3,
      }).kind,
    ).toBe("conflict");
    expect(
      test.owner.admit("other-actor", coordinates, "request-a", request).kind,
    ).toBe("conflict");
    expect(
      test.owner.admit("actor-a", coordinates, "request-a", {
        ...request,
        prompt: "different",
      }).kind,
    ).toBe("conflict");
    test.close();
  });

  it("CAS rejects stale workers and directly claims safe pre-dispatch recovery", async () => {
    const test = fixture();
    admit(test.owner);
    const claimed = await claim(test.owner);
    test.advance(5 * 60 * 1_000 + 1);
    expect(() => test.owner.recordEstimate(claimed.leaseId, 125)).toThrow();
    const recovered = await test.owner.claim();
    expect(recovered.kind).toBe("claimed");
    expect(recovered.operation.state).toBe("estimating");
    expect(recovered.leaseId).not.toBe(claimed.leaseId);
    expect(() => test.owner.recordEstimate(claimed.leaseId, 125)).toThrow();
    test.close();
  });

  it("settles an aborted provider call immediately and never retries that request", async () => {
    const test = fixture();
    admit(test.owner);
    const controller = new AbortController();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let providerSawAbort!: () => void;
    const sawAbort = new Promise<void>((resolve) => {
      providerSawAbort = resolve;
    });
    const run = vi.fn(
      (_signal?: AbortSignal) =>
        new Promise<{ bytes: Uint8Array; format: string }>(
          (_resolve, reject) => {
            providerStarted();
            _signal?.addEventListener(
              "abort",
              () => {
                providerSawAbort();
                reject(
                  new Error("Provider observed abort", {
                    cause: _signal.reason,
                  }),
                );
              },
              { once: true },
            );
          },
        ),
    );
    const write = vi.fn(() => Promise.resolve());
    const execution = execute(
      test.owner,
      "request-a",
      // The generation adapter receives the same signal delivered by the owner.
      run,
      write,
      controller.signal,
    );
    await started;
    controller.abort(new Error("App lifecycle ended"));
    await sawAbort;
    await expect(execution).resolves.toEqual({ kind: "interrupted" });
    expect(test.owner.read()).toMatchObject({
      state: "interrupted",
      estimatedCostMilliunits: 125,
      image: null,
    });
    expect(write).not.toHaveBeenCalled();
    expect((await test.owner.claim()).kind).toBe("interrupted");
    await expect(
      execute(
        test.owner,
        "request-a",
        () => Promise.resolve({ bytes: generatedBytes, format: "png" }),
        write,
      ),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(run).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    test.close();
  });

  it("makes an ambiguous generation terminal and non-retriable", async () => {
    const test = fixture();
    admit(test.owner, "request-generate");
    const claimResult = await claim(test.owner);
    test.owner.recordEstimate(claimResult.leaseId, 125);
    // The provider call may have happened, but its receipt was lost.
    test.advance(5 * 60 * 1_000 + 1);
    expect((await test.owner.claim()).kind).toBe("interrupted");
    expect((await test.owner.claim()).kind).toBe("interrupted");
    test.close();
  });

  it("reclaims an expired charge so its idempotent settlement can finish", async () => {
    const test = fixture();
    admit(test.owner, "request-charge");
    const stale = await reachCharging(test.owner);
    expect((await test.owner.claim()).kind).toBe("pending");
    test.advance(5 * 60 * 1_000 + 1);
    const recovered = await test.owner.claim();
    expect(recovered).toMatchObject({
      kind: "claimed",
      operation: { state: "charging", estimatedCostMilliunits: 125 },
    });
    expect(() =>
      test.owner.recordSucceeded(stale, {
        generationId: "media-operation-a",
        bytes: 3,
        format: "png",
        costMilliunits: 125,
      }),
    ).toThrow("Media operation conflict");
    test.close();
  });

  it("recovers an expired save lease from the retained exact output", async () => {
    const test = fixture();
    admit(test.owner, "request-write");
    const first = await claim(test.owner);
    test.owner.recordEstimate(first.leaseId, 125);
    await test.owner.recordGenerated(first.leaseId, generatedBytes, "png");
    test.advance(5 * 60 * 1_000 + 1);
    const recovered = await test.owner.claim();
    expect(recovered.kind).toBe("claimed");
    if (recovered.kind !== "claimed" || recovered.leaseId === undefined)
      throw new Error("save recovery failed");
    await expect(test.owner.readGenerated(recovered.leaseId)).resolves.toEqual(
      generatedBytes,
    );
    test.close();
  });

  it("reopens retained output and retries only the save after owner restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "fungi-media-operation-"));
    const databasePath = join(root, "operation.sqlite");
    const outputs = new Map<string, Uint8Array>();
    try {
      const first = fixture(databasePath, outputs);
      admit(first.owner, "request-restart-write");
      const claimed = await claim(first.owner);
      first.owner.recordEstimate(claimed.leaseId, 125);
      await first.owner.recordGenerated(claimed.leaseId, generatedBytes, "png");
      first.owner.releaseWrite(claimed.leaseId);
      first.close();

      const reopened = fixture(databasePath, outputs);
      const save = await claim(reopened.owner);
      await expect(reopened.owner.readGenerated(save.leaseId)).resolves.toEqual(
        generatedBytes,
      );
      expect(
        reopened.owner.recordWrittenWithoutSettlement(
          save.leaseId,
          "computer-write-committed",
          { bytes: 3, format: "png" },
        ).state,
      ).toBe("written");
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes the same executor request after estimating expires", async () => {
    const test = fixture();
    admit(test.owner);
    const stale = await claim(test.owner);
    test.advance(5 * 60 * 1_000 + 1);
    const run = vi.fn(() =>
      Promise.resolve({ bytes: generatedBytes, format: "png" }),
    );
    const write = vi.fn(() => Promise.resolve());
    await expect(
      execute(test.owner, "request-a", run, write),
    ).resolves.toMatchObject({ kind: "succeeded", costMilliunits: 125 });
    expect(run).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(generatedBytes);
    expect(test.owner.read()).toMatchObject({
      requestId: "request-a",
      state: "written",
    });
    expect(() => test.owner.recordEstimate(stale.leaseId, 125)).toThrow();
    test.close();
  });

  it("reopens output committed before its SQL receipt without regenerating", async () => {
    const root = mkdtempSync(join(tmpdir(), "fungi-media-output-gap-"));
    const databasePath = join(root, "operation.sqlite");
    const outputs = new Map<string, Uint8Array>();
    const run = vi.fn(() =>
      Promise.resolve({ bytes: generatedBytes, format: "png" }),
    );
    const write = vi.fn(() => Promise.resolve());
    try {
      const first = fixture(databasePath, outputs);
      const put = first.bucket.put;
      vi.spyOn(first.bucket, "put").mockImplementationOnce(
        async (key, bytes) => {
          await put(key, bytes);
          throw new Error(
            "Lost output-write acknowledgement before SQL receipt",
          );
        },
      );
      await expect(
        execute(first.owner, "request-a", run, write),
      ).rejects.toThrow();
      expect(first.owner.read()).toMatchObject({
        state: "generating",
        image: null,
      });
      expect(write).not.toHaveBeenCalled();
      first.advance(5 * 60 * 1_000 + 1);
      first.close();

      const reopened = fixture(databasePath, outputs);
      await expect(
        execute(reopened.owner, "request-a", run, write),
      ).resolves.toMatchObject({ kind: "succeeded", costMilliunits: 125 });
      expect(run).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledExactlyOnceWith(generatedBytes);
      expect(reopened.owner.read()).toMatchObject({
        state: "written",
        requestId: "request-a",
      });
      expect(
        reopened.owner.admit("actor-a", coordinates, "request-a", {
          ...request,
          computerId: "computer-b",
        }).kind,
      ).toBe("conflict");
      expect(
        reopened.owner.admit("actor-a", coordinates, "request-a", {
          ...request,
          path: "other.png",
        }).kind,
      ).toBe("conflict");
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fences competing recovery reads and rejects the expired writer", async () => {
    const test = fixture();
    admit(test.owner);
    const stale = await claim(test.owner);
    test.owner.recordEstimate(stale.leaseId, 125);
    const put = test.bucket.put;
    vi.spyOn(test.bucket, "put").mockImplementationOnce(async (key, bytes) => {
      await put(key, bytes);
      throw new Error("Lost output acknowledgement");
    });
    await expect(
      test.owner.recordGenerated(stale.leaseId, generatedBytes, "png"),
    ).rejects.toThrow();
    expect((await test.owner.claim()).kind).toBe("pending");
    test.advance(5 * 60 * 1_000 + 1);
    const results = await Promise.all([test.owner.claim(), test.owner.claim()]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "claimed",
      "pending",
    ]);
    const winner = results.find((result) => result.kind === "claimed");
    if (winner?.leaseId === undefined)
      throw new Error("Recovery claim missing");
    await expect(test.owner.readGenerated(winner.leaseId)).resolves.toEqual(
      generatedBytes,
    );
    await expect(
      test.owner.recordGenerated(stale.leaseId, generatedBytes, "png"),
    ).rejects.toThrow("lease_lost");
    test.close();
  });

  it("binds success facts to the stored generation, write, cost, and history facts", async () => {
    const test = fixture();
    admit(test.owner);
    const leaseId = await reachCharging(test.owner);
    expect(() =>
      test.owner.recordSucceeded(leaseId, {
        generationId: "wrong-operation",
        bytes: 3,
        format: "png",
        costMilliunits: 125,
      }),
    ).toThrow();
    expect(() =>
      test.owner.recordSucceeded(leaseId, {
        generationId: "media-operation-a",
        bytes: 3,
        format: "png",
        costMilliunits: 126,
      }),
    ).toThrow();
    const succeeded = test.owner.recordSucceeded(leaseId, {
      generationId: "media-operation-a",
      bytes: 3,
      format: "png",
      costMilliunits: 125,
    });
    expect(succeeded.state).toBe("succeeded");
    expect(test.owner.read()?.result).toEqual({
      generationId: "media-operation-a",
      bytes: 3,
      format: "png",
      costMilliunits: 125,
    });
    test.close();
  });

  it("can release only a safe pre-effect estimate", async () => {
    const test = fixture();
    admit(test.owner);
    const claimed = await claim(test.owner);
    expect(test.owner.releaseEstimate(claimed.leaseId).state).toBe("admitted");
    test.close();
  });

  it("terminalizes a completed write without claiming settlement", async () => {
    const test = fixture();
    admit(test.owner);
    const claimed = await claim(test.owner);
    test.owner.recordEstimate(claimed.leaseId, 125);
    await test.owner.recordGenerated(claimed.leaseId, generatedBytes, "png");
    const written = test.owner.recordWrittenWithoutSettlement(
      claimed.leaseId,
      "computer-write-committed",
      { bytes: 3, format: "png" },
    );
    expect(written.state).toBe("written");
    expect(written.image).toEqual({ bytes: 3, format: "png" });
    expect((await test.owner.claim()).kind).toBe("succeeded");
    test.close();
  });

  describe("with a billing owner", () => {
    /** An idempotent in-memory ledger keyed by operation id, like Billing's. */
    function ledger(
      options: Readonly<{
        refuse?: MediaBillingRefusal;
        failSettle?: number;
      }> = {},
    ) {
      const holds = new Map<string, number>();
      const charges = new Map<string, number>();
      let settleFailures = options.failSettle ?? 0;
      const metering: MediaMetering = {
        admit: vi.fn(
          ({
            operationId,
            providerCostMilliunits,
          }: Parameters<MediaMetering["admit"]>[0]) => {
            if (options.refuse !== undefined)
              return Promise.reject(options.refuse);
            const price = Math.ceil(providerCostMilliunits * 1.15);
            holds.set(operationId, price);
            return Promise.resolve({ priceMilliunits: price });
          },
        ),
        settle: vi.fn(
          ({ operationId, units }: Parameters<MediaMetering["settle"]>[0]) => {
            if (settleFailures > 0) {
              settleFailures -= 1;
              return Promise.reject(new Error("Billing unavailable"));
            }
            const held = holds.get(operationId);
            if (held !== undefined) {
              holds.delete(operationId);
              charges.set(operationId, held * units);
            }
            return Promise.resolve();
          },
        ),
      };
      return { metering, holds, charges };
    }
    const png = () => Promise.resolve({ bytes: generatedBytes, format: "png" });

    it("refuses before any provider dispatch and lets the same request retry after funding", async () => {
      const test = fixture();
      const run = vi.fn(png);
      const write = vi.fn(() => Promise.resolve());
      const refused = ledger({
        refuse: new MediaBillingRefusal("insufficient_credits"),
      });
      await expect(
        execute(
          test.owner,
          "request-a",
          run,
          write,
          undefined,
          refused.metering,
        ),
      ).rejects.toThrow("Media billing failed");
      expect(refused.metering.admit).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(test.owner.read()).toMatchObject({ state: "admitted" });

      const funded = ledger();
      await expect(
        execute(
          test.owner,
          "request-a",
          run,
          write,
          undefined,
          funded.metering,
        ),
      ).resolves.toEqual({
        kind: "succeeded",
        bytes: 3,
        format: "png",
        costMilliunits: 144,
      });
      expect(run).toHaveBeenCalledOnce();
      expect(funded.charges.get("media-operation-a")).toBe(144);
      expect(test.owner.read()).toMatchObject({
        state: "succeeded",
        estimatedCostMilliunits: 144,
        result: { costMilliunits: 144 },
      });
      // A replay returns the receipt and never charges again.
      await expect(
        execute(
          test.owner,
          "request-a",
          run,
          write,
          undefined,
          funded.metering,
        ),
      ).resolves.toMatchObject({ kind: "succeeded", costMilliunits: 144 });
      expect(funded.metering.settle).toHaveBeenCalledOnce();
      test.close();
    });

    it.each(["metered", "unmetered"])(
      "persists enriched file size through %s completion and replay",
      async (mode) => {
        const test = fixture();
        try {
          const original = await sharp({
            create: { width: 8, height: 8, channels: 3, background: "#285a8c" },
          })
            .png()
            .toBuffer();
          const run = vi.fn(() =>
            Promise.resolve({
              bytes: new Uint8Array(original),
              format: "png",
            }),
          );
          const write = vi.fn<(bytes: Uint8Array) => Promise<void>>(() =>
            Promise.resolve(),
          );
          const billing = mode === "metered" ? ledger().metering : "unmetered";
          const result = await execute(
            test.owner,
            "enriched-size",
            run,
            write,
            undefined,
            billing,
          );
          const saved = write.mock.calls[0]?.[0];
          if (saved === undefined) throw new Error("Expected a Computer write");
          expect(saved.byteLength).toBeGreaterThan(original.byteLength);
          expect(result).toMatchObject({
            kind: "succeeded",
            bytes: saved.byteLength,
          });
          expect(test.owner.read()?.image?.bytes).toBe(saved.byteLength);
          expect(
            await execute(
              test.owner,
              "enriched-size",
              run,
              write,
              undefined,
              billing,
            ),
          ).toEqual(result);
          expect(run).toHaveBeenCalledOnce();
          expect(write).toHaveBeenCalledOnce();
        } finally {
          test.close();
        }
      },
    );

    it("explains a Workers AI safety refusal without exposing provider details or charging", async () => {
      const test = fixture();
      const billing = ledger();
      const write = vi.fn(() => Promise.resolve());
      const marker = "synthetic-private-provider-details";
      const report = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const run = vi.fn(() =>
        Promise.reject(
          new Error(
            `8007: AiError: Input prompt contains NSFW content ${marker}`,
          ),
        ),
      );
      try {
        const service = createMediaService({
          scope: {
            actorId: "actor-a",
            namespace: "team-a",
            owner: "installation-a",
            destinationId: "computer-a",
          },
          operations: { getByName: () => test.owner },
          provider: createWorkersAiMediaProvider({ run }),
          metering: billing.metering,
          refusalMessages,
          destination: { authorize: () => Promise.resolve(), write },
        });
        const generationRequest = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "request-a",
          },
          body: JSON.stringify({
            path: request.path,
            settings: {
              model: "@cf/black-forest-labs/flux-1-schnell",
              prompt: "A single tiny ink mushroom on a plain white background",
              width: 1024,
              height: 768,
              steps: 1,
            },
          }),
        };
        const response = await service.request("/generate", generationRequest);
        expect(response.status).toBe(400);
        await expect(readMediaFailure(response)).resolves.toEqual({
          error:
            "The model's safety filter refused this prompt — try rewording.",
          stage: "provider",
          code: "SAFETY_FILTER_REFUSED",
          retryable: false,
        });
        expect(billing.charges.get("media-operation-a")).toBe(0);
        expect(billing.holds.size).toBe(0);
        expect(write).not.toHaveBeenCalled();
        expect((await test.owner.claim()).kind).toBe("interrupted");
        const replay = await service.request("/generate", generationRequest);
        expect(replay.status).toBe(400);
        await expect(readMediaFailure(replay)).resolves.toMatchObject({
          code: "SAFETY_FILTER_REFUSED",
          retryable: false,
        });
        expect(run).toHaveBeenCalledOnce();
        expect(JSON.stringify(report.mock.calls)).not.toContain(marker);
      } finally {
        report.mockRestore();
        test.close();
      }
    });

    it("charges nothing when the provider fails and ends the request", async () => {
      const test = fixture();
      const billing = ledger();
      const write = vi.fn(() => Promise.resolve());
      await expect(
        execute(
          test.owner,
          "request-a",
          () => Promise.reject(new Error("provider down")),
          write,
          undefined,
          billing.metering,
        ),
      ).rejects.toThrow("Media provider failed");
      expect(billing.charges.get("media-operation-a")).toBe(0);
      expect(billing.holds.size).toBe(0);
      expect(test.owner.read()).toMatchObject({ state: "interrupted" });
      expect(write).not.toHaveBeenCalled();
      test.close();
    });

    it("retries a lost settlement without regenerating or rewriting", async () => {
      const test = fixture();
      const billing = ledger({ failSettle: 1 });
      const original = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#285a8c" },
      })
        .png()
        .toBuffer();
      const run = vi.fn(() =>
        Promise.resolve({ bytes: new Uint8Array(original), format: "png" }),
      );
      const write = vi.fn<(bytes: Uint8Array) => Promise<void>>(() =>
        Promise.resolve(),
      );
      await expect(
        execute(
          test.owner,
          "request-a",
          run,
          write,
          undefined,
          billing.metering,
        ),
      ).rejects.toThrow("Media billing failed");
      const saved = write.mock.calls[0]?.[0];
      if (saved === undefined) throw new Error("Expected a Computer write");
      expect(saved.byteLength).toBeGreaterThan(original.byteLength);
      expect(test.owner.read()).toMatchObject({
        state: "charging",
        image: { bytes: saved.byteLength },
      });
      test.advance(5 * 60 * 1_000 + 1);
      await expect(
        execute(
          test.owner,
          "request-a",
          run,
          write,
          undefined,
          billing.metering,
        ),
      ).resolves.toMatchObject({ kind: "succeeded", costMilliunits: 144 });
      expect(run).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(billing.charges.get("media-operation-a")).toBe(144);
      test.close();
    });
  });

  describe("background video", () => {
    const videoRequest: MediaOperationRequest = {
      model: "bytedance/seedance-2.0",
      prompt: "fern fronds unfurling",
      width: 1280,
      height: 720,
      durationSeconds: 5,
      computerId: "computer-a",
      path: "generated/fern.mp4",
    };
    /** Replayed Seedance answer: the documented `{ state, result.video }`. */
    const mp4 = Uint8Array.from([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
      0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    ]);
    function perSecondLedger() {
      const settlements: { operationId: string; units: number }[] = [];
      const metering: MediaMetering = {
        admit: vi.fn(() => Promise.resolve({ priceMilliunits: 86_250 })),
        settle: vi.fn((input: { operationId: string; units: number }) => {
          settlements.push(input);
          return Promise.resolve();
        }),
      };
      return { metering, settlements };
    }
    function executeVideo(
      owner: MediaOperationOwner,
      metering: MediaMetering,
      write: (bytes: Uint8Array) => Promise<void>,
      run = vi.fn(),
      input: MediaOperationRequest = videoRequest,
      references: readonly MediaReferenceBytes[] = [],
    ) {
      return Effect.runPromise(
        executeMediaOperation({
          operation: owner,
          actorUserId: "actor-a",
          coordinates,
          requestId: "video-a",
          request: input,
          metering,
          destination: { authorize: () => Promise.resolve(), write },
          generation: {
            prepare: () =>
              Promise.resolve({ costMilliunits: 75_000, references, run }),
          },
        }),
      );
    }

    it("retains a video safety refusal across owner restart and settles its replay at zero units", async () => {
      const marker = "synthetic-private-video-details";
      const report = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const aiRun = vi.fn(() =>
        Promise.reject(
          new Error(
            `The prompt couldn't be submitted. It might violate our policies. ${marker}`,
          ),
        ),
      );
      const test = fixture(":memory:", new Map(), { run: aiRun });
      const billing = perSecondLedger();
      const write = vi.fn(() => Promise.resolve());
      let owner = test.owner;
      const provider = createWorkersAiMediaProvider({ run: aiRun });
      try {
        const service = createMediaService({
          scope: {
            actorId: "actor-a",
            ...coordinates,
            destinationId: "computer-a",
          },
          operations: { getByName: () => owner },
          provider,
          metering: billing.metering,
          refusalMessages,
          destination: { authorize: () => Promise.resolve(), write },
        });
        const generationRequest = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "video-a",
          },
          body: JSON.stringify({
            path: videoRequest.path,
            settings: {
              model: "google/veo-3.1",
              prompt: "fern fronds unfurling",
              width: 1280,
              height: 720,
              durationSeconds: 4,
            },
          }),
        };
        expect(
          (await service.request("/generate", generationRequest)).status,
        ).toBe(202);
        await owner.alarm();
        owner = new MediaOperationOwner(
          test.context,
          { APP_ARTIFACTS: test.bucket },
          () => provider,
        );
        const response = await service.request("/generate", generationRequest);
        expect(response.status).toBe(400);
        await expect(readMediaFailure(response)).resolves.toEqual({
          error:
            "The model's safety filter refused this prompt — try rewording.",
          stage: "provider",
          code: "SAFETY_FILTER_REFUSED",
          retryable: false,
        });
        expect(
          (await service.request("/generate", generationRequest)).status,
        ).toBe(400);
        await owner.alarm();
        expect(aiRun).toHaveBeenCalledOnce();
        expect(write).not.toHaveBeenCalled();
        expect(billing.settlements).toEqual([
          { operationId: "media-operation-a", units: 0 },
          { operationId: "media-operation-a", units: 0 },
        ]);
        expect(JSON.stringify(report.mock.calls)).not.toContain(marker);
      } finally {
        report.mockRestore();
        test.close();
      }
    });

    it("returns at once, generates once in the alarm, then saves and bills every second", async () => {
      const aiRun = vi.fn(() =>
        Promise.resolve({
          state: "Completed",
          result: { video: "https://results.example/fern.mp4" },
        }),
      );
      const results = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(mp4));

      const test = fixture(":memory:", new Map(), { run: aiRun });
      const billing = perSecondLedger();
      const write = vi.fn(() => Promise.resolve());
      const workerRun = vi.fn();
      await expect(
        executeVideo(test.owner, billing.metering, write, workerRun),
      ).resolves.toEqual({ kind: "accepted" });
      expect(billing.metering.admit).toHaveBeenCalledWith({
        operationId: "media-operation-a",
        model: "bytedance/seedance-2.0",
        unit: "video_second",
        units: 5,
        providerCostMilliunits: 75_000,
      });
      expect(workerRun).not.toHaveBeenCalled();
      expect(test.owner.read()).toMatchObject({
        state: "generating",
        estimatedCostMilliunits: 86_250,
      });
      // A retry while the alarm has not finished is still pending.
      await expect(
        executeVideo(test.owner, billing.metering, write),
      ).resolves.toEqual({ kind: "pending" });

      await test.owner.alarm();
      await test.owner.alarm();
      expect(aiRun).toHaveBeenCalledOnce();
      expect(aiRun).toHaveBeenCalledWith(
        "bytedance/seedance-2.0",
        {
          prompt: "fern fronds unfurling",
          duration: 5,
          resolution: "720p",
          aspect_ratio: "16:9",
        },
        { gateway: { id: "fungi-hub" } },
      );
      expect(test.owner.read()).toMatchObject({
        state: "writing",
        image: { format: "mp4", bytes: mp4.byteLength },
      });

      await expect(
        executeVideo(test.owner, billing.metering, write),
      ).resolves.toEqual({
        kind: "succeeded",
        bytes: mp4.byteLength,
        format: "mp4",
        costMilliunits: 86_250,
      });
      expect(write).toHaveBeenCalledExactlyOnceWith(mp4);
      expect(billing.settlements).toEqual([
        { operationId: "media-operation-a", units: 5 },
      ]);
      results.mockRestore();
      test.close();
    });

    it("retains an approved panel reference for the background Seedance call", async () => {
      const aiRun = vi.fn(() =>
        Promise.resolve({
          state: "Completed",
          result: { video: "https://results.example/fern.mp4" },
        }),
      );
      const results = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(mp4));

      const test = fixture(":memory:", new Map(), { run: aiRun });
      const billing = perSecondLedger();
      const write = vi.fn(() => Promise.resolve());
      const reference: MediaReferenceBytes = {
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
        format: "png",
        width: 1024,
        height: 1024,
      };
      const input: MediaOperationRequest = {
        ...videoRequest,
        references: [{ computerId: "computer-a", path: "/Pictures/panel.png" }],
      };
      await expect(
        executeVideo(test.owner, billing.metering, write, vi.fn(), input, [
          reference,
        ]),
      ).resolves.toEqual({ kind: "accepted" });
      await test.owner.alarm();
      expect(aiRun).toHaveBeenCalledWith(
        "bytedance/seedance-2.0",
        expect.objectContaining({
          image: `data:image/png;base64,${btoa(String.fromCharCode(...reference.bytes))}`,
        }),
        { gateway: { id: "fungi-hub" } },
      );
      await expect(
        executeVideo(test.owner, billing.metering, write, vi.fn(), input, [
          reference,
        ]),
      ).resolves.toMatchObject({ kind: "succeeded", format: "mp4" });
      expect(billing.settlements).toEqual([
        { operationId: "media-operation-a", units: 5 },
      ]);
      results.mockRestore();
      test.close();
    });

    it("ends a failed background generation and releases its hold at zero", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const aiRun = vi.fn(() => Promise.reject(new Error("3040: busy")));

      const test = fixture(":memory:", new Map(), { run: aiRun });
      const billing = perSecondLedger();
      const write = vi.fn(() => Promise.resolve());
      await executeVideo(test.owner, billing.metering, write);
      await test.owner.alarm();
      expect(test.owner.read()).toMatchObject({ state: "interrupted" });
      await expect(
        executeVideo(test.owner, billing.metering, write),
      ).resolves.toEqual({ kind: "unavailable" });
      expect(billing.settlements).toEqual([
        { operationId: "media-operation-a", units: 0 },
      ]);
      expect(write).not.toHaveBeenCalled();
      test.close();
    });
  });
});

describe("durable requested image format", () => {
  it("pins the requested format in replay identity and refuses a mismatched output before storing it", async () => {
    const test = fixture();
    try {
      const input = { ...request, outputFormat: "png" as const };
      const admitted = test.owner.admit(
        "actor-a",
        coordinates,
        "format-request",
        input,
      );
      expect(admitted.kind).toBe("admitted");
      expect(
        test.owner.admit("actor-a", coordinates, "format-request", {
          ...input,
          outputFormat: "jpeg",
        }),
      ).toMatchObject({ kind: "conflict" });
      const lease = await claim(test.owner);
      test.owner.recordEstimate(lease.leaseId, 125);
      await expect(
        test.owner.recordGenerated(lease.leaseId, generatedBytes, "jpeg"),
      ).resolves.toEqual({ kind: "refused", code: "output_format_mismatch" });
      expect(test.owner.read()?.image).toBeNull();
      expect(test.owner.read()).toMatchObject({
        state: "interrupted",
        spentFailure: "output_format_mismatch",
      });
      await expect(
        test.owner.recordGenerated(lease.leaseId, generatedBytes, "png"),
      ).rejects.toThrow("lease_lost");
    } finally {
      test.close();
    }
  });
});

it("charges a provider format mismatch durably and never redispatches or refunds its replay", async () => {
  const test = fixture();
  const run = vi.fn(() =>
    Promise.resolve({ bytes: generatedBytes, format: "jpeg" }),
  );
  const settle = vi.fn(() => Promise.resolve());
  const write = vi.fn(() => Promise.resolve());
  const execution = {
    operation: test.owner,
    actorUserId: "actor-a",
    coordinates,
    requestId: "mismatched-format",
    request: { ...request, outputFormat: "png" as const },
    metering: {
      admit: () => Promise.resolve({ priceMilliunits: 125 }),
      settle,
    },
    destination: { authorize: () => Promise.resolve(), write },
    generation: {
      prepare: () =>
        Promise.resolve({ costMilliunits: 125, references: [], run }),
    },
  };
  try {
    await expect(
      Effect.runPromise(executeMediaOperation(execution)),
    ).rejects.toThrow();
    expect(settle.mock.calls).toEqual([
      [{ operationId: "media-operation-a", units: 1 }],
    ]);
    await expect(
      Effect.runPromise(executeMediaOperation(execution)),
    ).rejects.toThrow();
    expect(settle.mock.calls).toEqual([
      [{ operationId: "media-operation-a", units: 1 }],
      [{ operationId: "media-operation-a", units: 1 }],
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  } finally {
    test.close();
  }
});
