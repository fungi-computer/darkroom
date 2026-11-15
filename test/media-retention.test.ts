import sharp from "sharp";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeMediaOperation } from "../src/media-operation.js";
import {
  MediaOperationOwner,
  type MediaOperationCoordinates,
  type MediaOperationRequest,
} from "../src/media-operation-owner.js";
import {
  eraseMediaOperation,
  readRetainedMedia,
  retainedMedia,
  removeMediaIfWritten,
  type MediaRemoval,
  type MediaServiceHost,
} from "../src/server.js";
import { mediaOperationFixture as fixture } from "./fixtures/media-operation.fixture.js";

const coordinates: MediaOperationCoordinates = {
  namespace: "team-a",
  owner: "installation-a",
};
const request: MediaOperationRequest = {
  model: "@cf/black-forest-labs/flux-2-klein-4b",
  prompt: "a private greenhouse",
  width: 1_024,
  height: 768,
  computerId: "computer-a",
  path: "generated/greenhouse.png",
};
const outputKey = "media-output/v1/media:request-a";
const generated = new Uint8Array([1, 2, 3]);

function make(outputs = new Map<string, Uint8Array>()) {
  return fixture(":memory:", outputs, undefined, "media:request-a");
}
function admit(owner: MediaOperationOwner) {
  return owner.admit("actor-a", coordinates, "request-a", request);
}
async function generating(owner: MediaOperationOwner) {
  admit(owner);
  const claimed = await owner.claim();
  if (claimed.leaseId === undefined) throw new Error("claim failed");
  owner.recordEstimate(claimed.leaseId, 125);
  return claimed.leaseId;
}
async function image(format: "png" | "jpeg" | "webp") {
  return new Uint8Array(
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 40, g: 90, b: 140 },
      },
    })
      .toFormat(format)
      .toBuffer(),
  );
}
function run(
  owner: MediaOperationOwner,
  bytes: Uint8Array,
  format: string,
  extra: {
    embedPrompt?: boolean | undefined;
    metering?: MediaServiceHost["metering"];
    write?: (bytes: Uint8Array) => Promise<void>;
    remove?: ((sha256: string) => Promise<MediaRemoval>) | undefined;
  },
) {
  return Effect.runPromise(
    executeMediaOperation({
      operation: owner,
      actorUserId: "actor-a",
      coordinates,
      requestId: "request-a",
      request,
      metering: extra.metering ?? "unmetered",
      embedPrompt: extra.embedPrompt,
      destination: {
        authorize: () => Promise.resolve(),
        write: extra.write ?? (() => Promise.resolve()),
        remove: extra.remove ?? (() => Promise.resolve("absent")),
      },
      generation: {
        prepare: () =>
          Promise.resolve({
            costMilliunits: 125,
            references: [],
            audioReferences: [],
            run: () => Promise.resolve({ bytes, format }),
          }),
      },
    }),
  );
}

describe("private prompt metadata through a generation", () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    it(`${format}: saved file omits the prompt by default and carries it on opt-in`, async () => {
      for (const embedPrompt of [undefined, false, true]) {
        const test = make();
        try {
          const saved: Uint8Array[] = [];
          await run(test.owner, await image(format), format, {
            embedPrompt,
            write: (bytes) => {
              saved.push(bytes);
              return Promise.resolve();
            },
          });
          const xmp = new TextDecoder().decode(
            (await sharp(saved[0]).metadata()).xmp,
          );
          expect(xmp).toContain("fungi:printId");
          if (embedPrompt === true) {
            expect(xmp).toContain("fungi:prompt");
            expect(xmp).toContain("a private greenhouse");
          } else {
            expect(xmp).not.toContain("fungi:prompt");
            expect(xmp).not.toContain("private greenhouse");
          }
        } finally {
          test.close();
        }
      }
    });
  }
});

function host(
  test: ReturnType<typeof make>,
  files: Map<string, Uint8Array>,
  metering: MediaServiceHost["metering"] = "unmetered",
  namespace = "team-a",
) {
  return {
    scope: {
      actorId: "actor-a",
      namespace,
      owner: "installation-a",
      destinationId: "computer-a",
    },
    operations: { getByName: () => test.owner },
    metering,
    destination: {
      authorize: () => Promise.resolve(),
      write: (path: string, bytes: Uint8Array) => {
        files.set(path, bytes);
        return Promise.resolve();
      },
      remove: (path: string, written: { sha256: string }) =>
        removeMediaIfWritten(
          {
            read: () => Promise.resolve(files.get(path) ?? null),
            delete: () => {
              files.delete(path);
              return Promise.resolve();
            },
          },
          written.sha256,
        ),
    },
  } satisfies Pick<
    MediaServiceHost,
    "scope" | "operations" | "destination" | "metering"
  >;
}

describe("erasing retained results", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });
  afterEach(() => vi.useRealTimers());

  it("erases an operation that is still generating and refuses its later output", async () => {
    const outputs = new Map<string, Uint8Array>();
    const test = make(outputs);
    try {
      const lease = await generating(test.owner);
      expect(await test.owner.erase("team-a", "request-a")).toEqual({
        clear: true,
        destinationPath: "generated/greenhouse.png",
        writtenSha256: null,
        abandonedGeneration: true,
      });
      await expect(
        test.owner.recordGenerated(lease, generated, "png"),
      ).rejects.toThrow("not_found");
      expect(() => {
        test.owner.recordWriteIntent(lease, "a".repeat(64));
      }).toThrow("not_found");
      expect(outputs.size).toBe(0);
    } finally {
      test.close();
    }
  });

  it("keeps the write digest through recovery of an expired writing lease", async () => {
    const test = make();
    try {
      const lease = await generating(test.owner);
      await test.owner.recordGenerated(lease, generated, "png");
      const sha256 = "b".repeat(64);
      test.owner.recordWriteIntent(lease, sha256);
      // The write landed, then the worker died before recording it.
      vi.setSystemTime(Date.now() + 10 * 60 * 1_000);
      expect((await test.owner.claim()).kind).toBe("claimed");
      expect(
        (await test.owner.erase("team-a", "request-a")).writtenSha256,
      ).toBe(sha256);
    } finally {
      test.close();
    }
  });

  it("releases the hold a worker opened after erasure already settled", async () => {
    const test = make();
    const settle = vi.fn(() => Promise.resolve());
    try {
      await expect(
        run(test.owner, await image("png"), "png", {
          metering: {
            // Erasure lands while the worker is admitting.
            admit: async () => {
              await test.owner.erase("team-a", "request-a");
              return { priceMilliunits: 125 };
            },
            settle,
          },
        }),
      ).rejects.toThrow();
      expect(settle).toHaveBeenCalledWith({
        operationId: "media:request-a",
        units: 0,
      });
    } finally {
      test.close();
    }
  });

  it("erases an operation whose lease expired mid-generation instead of holding it", async () => {
    const test = make();
    try {
      await generating(test.owner);
      vi.setSystemTime(Date.now() + 10 * 60 * 1_000);
      expect((await test.owner.erase("team-a", "request-a")).clear).toBe(true);
      await expect(test.owner.claim()).rejects.toThrow("not_found");
    } finally {
      test.close();
    }
  });

  it("refuses an active operation atomically when the host asks to wait for inactivity", async () => {
    const test = make();
    try {
      const lease = await generating(test.owner);
      await expect(
        test.owner.erase("team-a", "request-a", "refuse-active"),
      ).rejects.toThrow("still active");
      // Nothing was marked: the generation continues.
      await test.owner.recordGenerated(lease, generated, "png");
      expect(test.owner.read()?.state).toBe("writing");
    } finally {
      test.close();
    }
  });

  it("keeps the erasure marker and destination facts through a crash mid-cleanup", async () => {
    const test = make();
    try {
      await generating(test.owner);
      vi.spyOn(test.context.storage, "deleteKeys").mockRejectedValueOnce(
        new Error("process died"),
      );
      await expect(test.owner.erase("team-a", "request-a")).rejects.toThrow(
        "process died",
      );
      // A restart reads the durable marker: the operation stays erased, so the
      // same request id cannot generate and charge again.
      const restarted = new MediaOperationOwner(test.context, {
        APP_ARTIFACTS: test.bucket,
      });
      await Promise.resolve();
      expect(() => admit(restarted)).toThrow("not_found");
      await expect(restarted.claim()).rejects.toThrow("not_found");
      expect(await restarted.erase("team-a", "request-a")).toEqual({
        clear: true,
        destinationPath: request.path,
        writtenSha256: null,
        abandonedGeneration: true,
      });
      // Nothing, not even a completed erase, removes the marker.
      const again = new MediaOperationOwner(test.context, {
        APP_ARTIFACTS: test.bucket,
      });
      await Promise.resolve();
      expect(() => admit(again)).toThrow("not_found");
      expect((await again.erase("team-a", "request-a")).destinationPath).toBe(
        request.path,
      );
    } finally {
      test.close();
    }
  });

  it("reports not clear while a put is in flight, then deletes what landed on a repeat", async () => {
    const outputs = new Map<string, Uint8Array>();
    const test = make(outputs);
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      ...test.bucket,
      put: async (...input: Parameters<typeof test.bucket.put>) => {
        entered = true;
        await gate;
        return test.bucket.put(...input);
      },
    };
    try {
      await Promise.resolve();
      const owner = new MediaOperationOwner(test.context, {
        APP_ARTIFACTS: slow,
      });
      const lease = await generating(owner);
      const late = owner.recordGenerated(lease, generated, "png");
      const settled = expect(late).rejects.toThrow("not_found");
      await vi.waitFor(() => {
        expect(entered).toBe(true);
      });
      expect((await owner.erase("team-a", "request-a")).clear).toBe(false);
      release();
      await settled;
      expect((await owner.erase("team-a", "request-a")).clear).toBe(true);
      expect(outputs.size).toBe(0);
    } finally {
      test.close();
    }
  });

  it("remembers a failed late delete and retries it on the next erase", async () => {
    const outputs = new Map<string, Uint8Array>();
    const test = make(outputs);
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      ...test.bucket,
      put: async (...input: Parameters<typeof test.bucket.put>) => {
        entered = true;
        await gate;
        return test.bucket.put(...input);
      },
    };
    try {
      await Promise.resolve();
      const owner = new MediaOperationOwner(test.context, {
        APP_ARTIFACTS: slow,
      });
      const lease = await generating(owner);
      const late = owner.recordGenerated(lease, generated, "png");
      await vi.waitFor(() => {
        expect(entered).toBe(true);
      });
      await owner.erase("team-a", "request-a");
      // Keep the late bytes: the first delete after the put lands fails.
      vi.spyOn(slow, "delete").mockRejectedValueOnce(new Error("r2 down"));
      release();
      await expect(late).rejects.toThrow("r2 down");
      expect(outputs.has(outputKey)).toBe(true);
      expect((await owner.readErasure()).clear).toBe(false);
      expect((await owner.erase("team-a", "request-a")).clear).toBe(true);
      expect(outputs.size).toBe(0);
    } finally {
      test.close();
    }
  });

  it("deletes background reference copies a dispatch was writing during erasure", async () => {
    const outputs = new Map<string, Uint8Array>();
    const test = make(outputs);
    try {
      test.owner.admit("actor-a", coordinates, "request-a", {
        ...request,
        references: [{ computerId: "computer-a", path: "/Pictures/panel.png" }],
      });
      const claimed = await test.owner.claim();
      const lease = claimed.leaseId ?? "";
      test.owner.recordEstimate(lease, 125);
      await test.owner.dispatchInBackground(
        lease,
        [
          {
            bytes: generated,
            format: "png",
            width: 1,
            height: 1,
            filename: "panel.png",
          },
        ],
        [],
      );
      expect(outputs.size).toBe(1);
      expect((await test.owner.erase("team-a", "request-a")).clear).toBe(true);
      expect(outputs.size).toBe(0);
    } finally {
      test.close();
    }
  });

  it("deletes the destination file when erasure wins the race with its write", async () => {
    const test = make();
    const files = new Map<string, Uint8Array>();
    const removed: string[] = [];
    try {
      await expect(
        run(test.owner, await image("png"), "png", {
          write: async (bytes) => {
            files.set(request.path, bytes);
            await test.owner.erase("team-a", "request-a");
          },
          remove: (sha256) => {
            removed.push(sha256);
            files.delete(request.path);
            return Promise.resolve("removed");
          },
        }),
      ).rejects.toThrow();
      expect(files.size).toBe(0);
      expect(removed).toHaveLength(1);
      // The digest recorded before the write is the one kept for the host.
      expect(
        (await test.owner.erase("team-a", "request-a")).writtenSha256,
      ).toBe(removed[0]);
    } finally {
      test.close();
    }
  });
});

describe("recovering and erasing by operation id", () => {
  it("lists and reads output a crash left unrecorded, then erases it", async () => {
    const outputs = new Map<string, Uint8Array>();
    const test = make(outputs);
    const files = new Map<string, Uint8Array>();
    try {
      await generating(test.owner);
      // The R2 write committed, then the process died before SQL recorded it.
      outputs.set(outputKey, generated);
      const h = host(test, files);
      expect(await retainedMedia(h, "request-a")).toEqual({
        requestId: "request-a",
        state: "generating",
        destinationPath: request.path,
        output: { bytes: 3, format: "png", contentType: "image/png" },
      });
      expect(await readRetainedMedia(h, "request-a")).toEqual({
        bytes: generated,
        format: "png",
      });
      expect(await eraseMediaOperation(h, "request-a")).toMatchObject({
        clear: true,
        destinationPath: request.path,
        destinationFile: null,
      });
      expect(outputs.size).toBe(0);
      expect(await retainedMedia(h, "request-a")).toBeNull();
      expect(await readRetainedMedia(h, "request-a")).toBeNull();
    } finally {
      test.close();
    }
  });

  it("refuses to list or read another namespace's operation", async () => {
    const test = make();
    try {
      admit(test.owner);
      const other = host(test, new Map(), "unmetered", "team-b");
      await expect(retainedMedia(other, "request-a")).rejects.toThrow(
        "scope mismatch",
      );
      await expect(readRetainedMedia(other, "request-a")).rejects.toThrow(
        "scope mismatch",
      );
    } finally {
      test.close();
    }
  });

  it("deletes the saved file only while it still holds what the operation wrote", async () => {
    for (const reused of [false, true]) {
      const test = make();
      const files = new Map<string, Uint8Array>();
      try {
        const h = host(test, files);
        await run(test.owner, await image("png"), "png", {
          write: (bytes) => h.destination.write(request.path, bytes),
        });
        const other = new Uint8Array([9, 9, 9]);
        if (reused) files.set(request.path, other);
        const erased = await eraseMediaOperation(h, "request-a");
        expect(erased.destinationFile).toBe(reused ? "not-ours" : "removed");
        expect(files.get(request.path)).toEqual(reused ? other : undefined);
        // A retry reports the same, from the marker kept through erasure.
        expect(
          (await eraseMediaOperation(h, "request-a")).destinationFile,
        ).toBe(reused ? "not-ours" : "absent");
      } finally {
        test.close();
      }
    }
  });

  it("keeps the destination facts so a failed file delete can be retried", async () => {
    const test = make();
    const files = new Map<string, Uint8Array>();
    try {
      const h = host(test, files);
      await run(test.owner, await image("png"), "png", {
        write: (bytes) => h.destination.write(request.path, bytes),
      });
      const remove = vi
        .spyOn(h.destination, "remove")
        .mockRejectedValueOnce(new Error("bucket unavailable"));
      await expect(eraseMediaOperation(h, "request-a")).rejects.toThrow(
        "bucket unavailable",
      );
      expect(files.size).toBe(1);
      expect(await eraseMediaOperation(h, "request-a")).toMatchObject({
        clear: true,
        destinationFile: "removed",
      });
      expect(remove).toHaveBeenCalledTimes(2);
      expect(files.size).toBe(0);
    } finally {
      test.close();
    }
  });

  it("settles an abandoned generation's billing hold at zero, and never a finished one", async () => {
    for (const finished of [false, true]) {
      const test = make();
      const settle = vi.fn(() => Promise.resolve());
      const metering = {
        admit: () => Promise.resolve({ priceMilliunits: 125 }),
        settle,
      };
      try {
        const h = host(test, new Map(), metering);
        if (finished)
          await run(test.owner, await image("png"), "png", {
            write: () => Promise.resolve(),
          });
        else await generating(test.owner);
        const erased = await eraseMediaOperation(h, "request-a");
        expect(erased.abandonedGeneration).toBe(!finished);
        if (finished) expect(settle).not.toHaveBeenCalled();
        else
          expect(settle).toHaveBeenCalledWith({
            operationId: "media:request-a",
            units: 0,
          });
      } finally {
        test.close();
      }
    }
  });

  it("resumes an erasure that stopped after the marker, with the operation still refusing work", async () => {
    const outputs = new Map<string, Uint8Array>();
    const test = make(outputs);
    try {
      const lease = await generating(test.owner);
      await test.owner.recordGenerated(lease, generated, "png");
      const del = vi
        .spyOn(test.bucket, "delete")
        .mockRejectedValueOnce(new Error("r2 down"));
      await expect(test.owner.erase("team-a", "request-a")).rejects.toThrow(
        "r2 down",
      );
      await expect(test.owner.claim()).rejects.toThrow("not_found");
      expect((await test.owner.erase("team-a", "request-a")).clear).toBe(true);
      expect(del).toHaveBeenCalled();
      expect(outputs.size).toBe(0);
    } finally {
      test.close();
    }
  });
});
