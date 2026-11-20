import * as Schema from "effect/Schema";
import { vi } from "vitest";
import { createNativeSqliteFixture } from "./native-sqlite.fixture.js";
import type { MediaErasureMarker } from "../../src/media-operation-storage.js";
import {
  MediaOperationOwner,
  type MediaOperationHooks,
} from "../../src/media-operation-owner.js";
import {
  createWorkersAiMediaProvider,
  type MediaAiPort,
} from "../../src/cloudflare/provider.js";

export function mediaOperationFixture(
  databasePath = ":memory:",
  outputs = new Map<string, Uint8Array>(),
  ai?: MediaAiPort,
  objectName = "media-operation-a",
  hooks: MediaOperationHooks = {},
) {
  const native = createNativeSqliteFixture(databasePath);
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  const metadata = new Map<string, Record<string, string>>();
  const bucket = {
    put: (
      key: string,
      value: Uint8Array,
      options?: { customMetadata?: Record<string, string> },
    ) => {
      if (outputs.has(key)) return Promise.resolve(null);
      const bytes = value.slice();
      outputs.set(key, bytes);
      if (options?.customMetadata) metadata.set(key, options.customMetadata);
      return Promise.resolve({
        key,
        version: "version-1",
        size: bytes.byteLength,
      });
    },
    head: (key: string) => {
      const bytes = outputs.get(key);
      return Promise.resolve(
        bytes === undefined
          ? null
          : {
              key,
              version: "version-1",
              size: bytes.byteLength,
              httpMetadata: { contentType: "image/png" },
            },
      );
    },
    get: (key: string) => {
      const bytes = outputs.get(key);
      return Promise.resolve(
        bytes === undefined
          ? null
          : {
              key,
              version: "version-1",
              size: bytes.byteLength,
              customMetadata: metadata.get(key) ?? {},
              arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
            },
      );
    },
    delete: (key: string) => {
      outputs.delete(key);
      metadata.delete(key);
      return Promise.resolve();
    },
  };
  const state = {
    id: { name: objectName },
    storage: {
      sql: native.storage.sql,
      transactionSync: native.storage.transactionSync,
      isErased: () => Promise.resolve(kv.get("botanical:erased") === true),
      markErased: (marker: MediaErasureMarker) => {
        kv.set("botanical:erased-details", marker);
        kv.set("botanical:erased", true);
        return Promise.resolve();
      },
      readErasureMarker: () =>
        Promise.resolve(
          Schema.decodeUnknownSync(
            Schema.UndefinedOr(
              Schema.Struct({
                destinationPath: Schema.NullOr(Schema.String),
                writtenSha256: Schema.NullOr(Schema.String),
                abandonedGeneration: Schema.Boolean,
              }),
            ),
          )(kv.get("botanical:erased-details")) ?? null,
        ),
      listKeys: () => Promise.resolve([...kv.keys()]),
      deleteAlarm: () => {
        alarm = null;
        return Promise.resolve();
      },
      deleteKeys: (keys: readonly string[]) => {
        for (const key of keys) kv.delete(key);
        return Promise.resolve();
      },
      getAlarm: () => Promise.resolve(alarm),
      setAlarm: (value: number) => {
        alarm = value;
        return Promise.resolve();
      },
    },
    blockConcurrencyWhile: <T>(body: () => T | Promise<T>) =>
      Promise.resolve(body()),
  };

  const artifacts = bucket;
  const owner = new MediaOperationOwner(
    state,
    { APP_ARTIFACTS: artifacts },
    ai === undefined
      ? undefined
      : () =>
          createWorkersAiMediaProvider(ai, { gateway: { id: "fungi-hub" } }),
    hooks,
  );
  return {
    owner,
    context: state,
    storage: native.storage,
    bucket,
    advance: (milliseconds: number) => vi.advanceTimersByTime(milliseconds),
    close: native.close,
  };
}
