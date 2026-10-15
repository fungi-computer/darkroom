import * as Schema from "effect/Schema";
import { vi } from "vitest";
import { createNativeSqliteOwnerFixture } from "../../../../packages/shiitake/test/fixtures/native-sqlite-owner.fixture.js";
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
  const native = createNativeSqliteOwnerFixture(databasePath);
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
      sql: native.owner.sql,
      transactionSync: native.owner.transactionSync,
      isErased: () => Promise.resolve(kv.get("botanical:erased") === true),
      markErased: () => {
        kv.set("botanical:erased", true);
        return Promise.resolve();
      },
      listKeys: () => Promise.resolve([...kv.keys()]),
      deleteAlarm: () => {
        alarm = null;
        return Promise.resolve();
      },
      deleteAll: () => {
        kv.clear();
        const tables = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ name: Schema.String })),
        )(
          native.owner.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .toArray(),
        );
        for (const { name } of tables)
          native.owner.sql.exec(`DROP TABLE ${name}`);
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
    storage: native.owner,
    bucket,
    advance: (milliseconds: number) => vi.advanceTimersByTime(milliseconds),
    close: native.close,
  };
}
