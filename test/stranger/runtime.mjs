import { newMessagePortRpcSession } from "@fungi.computer/capnweb";
import { createCapabilityRegistry } from "@fungi.computer/agar";
import {
  mediaGeneration,
  openMediaGeneration,
} from "@fungi.computer/agar/media";
import assert from "node:assert/strict";
import { atob } from "node:buffer";
import console from "node:console";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel } from "node:worker_threads";
import {
  listMediaModels,
  validateMediaVideoSelection,
  estimateVideoMilliunits,
  validateMediaGenerationSettings,
} from "@fungi.computer/darkroom";
import { mediaRequestIds } from "@fungi.computer/agar/media-request-id";
import {
  appMediaGenerationResultSchema,
  destinationSchema,
  mediaModelsSchema,
  appMediaGenerationOutcomeSchema,
  appMediaModelsOutcomeSchema,
} from "@fungi.computer/darkroom/app-media-contracts";

assert.deepEqual(mediaModelsSchema.parse(listMediaModels()), listMediaModels());
assert.deepEqual(appMediaModelsOutcomeSchema.parse({ error: "not_granted" }), {
  error: "not_granted",
});
assert.deepEqual(
  appMediaGenerationOutcomeSchema.parse({
    kind: "pending",
    retryAfterMs: 5000,
  }),
  { kind: "pending", retryAfterMs: 5000 },
);
assert.deepEqual(destinationSchema.parse({ computerId: "local", path: "/" }), {
  computerId: "local",
  path: "/",
});
assert.equal(
  appMediaGenerationResultSchema.safeParse({
    kind: "pending",
    retryAfterMs: 5000,
  }).success,
  false,
);
import {
  createMediaService,
  MediaOperationOwner,
  MediaBillingRefusal,
} from "@fungi.computer/darkroom/server";
import { stripPrivateProvenance } from "@fungi.computer/darkroom/provenance";
import {
  MediaGeneration,
  MediaGenerationAttempt,
} from "@fungi.computer/agar/media-json";

const image = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (character) => character.charCodeAt(0),
);
const outputs = new Map();
const bucket = {
  async put(key, bytes, options) {
    if (outputs.has(key)) return null;
    outputs.set(key, { bytes: bytes.slice(), options });
    return { version: "v1" };
  },
  async head(key) {
    const output = outputs.get(key);
    return output === undefined
      ? null
      : {
          key,
          version: "v1",
          size: output.bytes.length,
          httpMetadata: output.options?.httpMetadata,
        };
  },
  async get(key) {
    const output = outputs.get(key);
    return output === undefined
      ? null
      : {
          key,
          version: "v1",
          size: output.bytes.length,
          customMetadata: output.options?.customMetadata,
          arrayBuffer: async () => output.bytes.slice().buffer,
        };
  },
  async delete(key) {
    outputs.delete(key);
  },
};
const databases = [];
const initializations = [];
const owners = new Map();
const operations = {
  getByName(name) {
    if (owners.has(name)) return owners.get(name);
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const kv = new Map();
    let alarm = null;
    const sql = {
      exec(statement, ...bindings) {
        const prepared = database.prepare(statement);
        const rows = prepared.columns().length
          ? prepared.all(...bindings)
          : (prepared.run(...bindings), []);
        return { toArray: () => rows };
      },
    };
    const owner = new MediaOperationOwner(
      {
        id: { name },
        blockConcurrencyWhile(body) {
          const initialized = body();
          initializations.push(initialized);
          return initialized;
        },
        storage: {
          sql,
          transactionSync(body) {
            database.exec("BEGIN");
            try {
              const value = body();
              database.exec("COMMIT");
              return value;
            } catch (cause) {
              database.exec("ROLLBACK");
              throw cause;
            }
          },
          async isErased() {
            return kv.get("botanical:erased") === true;
          },
          async markErased() {
            kv.set("botanical:erased", true);
          },
          async listKeys() {
            return [...kv.keys()];
          },
          async deleteAlarm() {
            alarm = null;
          },
          async getAlarm() {
            return alarm;
          },
          async setAlarm(timestamp) {
            alarm = timestamp;
          },
          async deleteAll() {
            kv.clear();
            database.exec("DROP TABLE hub_media_operation");
            database.exec("DROP TABLE hub_media_spent_failure");
            database.exec("DROP TABLE hub_media_provider_refusal");
          },
        },
      },
      { APP_ARTIFACTS: bucket },
    );
    owners.set(name, owner);
    return owner;
  },
};
let providerCalls = 0;
let failSave = true;
const saved = [];
const host = {
  scope: {
    actorId: "reader",
    namespace: "studio",
    owner: "illustrator",
    destinationId: "pictures",
  },
  operations,
  async provider() {
    providerCalls++;
    return { bytes: image.slice(), format: "gif" };
  },
  metering: "unmetered",
  destination: {
    authorize: () => Promise.resolve(),
    async write(path, bytes) {
      if (failSave) {
        failSave = false;
        throw new Error("Fixture destination unavailable");
      }
      saved.push({ path, bytes: bytes.slice() });
    },
  },
};
const settings = validateMediaGenerationSettings({
  model: "@cf/black-forest-labs/flux-1-schnell",
  prompt: "a quiet greenhouse",
  width: 1024,
  height: 768,
});
const body = { path: "picture.gif", settings };
const generate = (service, requestId = "first-picture", input = body) =>
  service.request("/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
    body: JSON.stringify(input),
  });
try {
  assert.equal(listMediaModels().length, 13);
  const service = createMediaService(host);
  assert.equal((await (await service.request("/models")).json()).length, 13);
  assert.equal((await generate(service)).status, 503);
  assert.equal(saved.length, 0);
  const retry = await generate(service);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).path, "picture.gif");
  assert.equal((await generate(service)).status, 200);
  assert.equal(providerCalls, 1);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].bytes, image);
  const owner = owners.get("media:first-picture");
  assert.equal(owner.read().namespace, "studio");
  assert.equal(owner.read().owner, "illustrator");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(
        databases[0]
          .prepare("SELECT team_id,installation_id FROM hub_media_operation")
          .get(),
      ),
    ),
    { team_id: "studio", installation_id: "illustrator" },
  );
  assert.equal(
    (await generate(service, "first-picture", { ...body, path: "other.gif" }))
      .status,
    409,
  );
  const exported = await stripPrivateProvenance(image);
  assert.equal(exported.type, "image/gif");
  assert.deepEqual(exported.bytes, image);
  for (const [reason, status] of [
    ["insufficient_credits", 402],
    ["daily_limit_reached", 402],
    ["denied", 403],
  ]) {
    const metered = createMediaService({
      ...host,
      metering: {
        async admit() {
          throw new MediaBillingRefusal(reason);
        },
        settle: () => Promise.resolve(),
      },
      refusalMessages: {
        insufficient_credits: "Refill your studio balance.",
        daily_limit_reached: "Studio quota reached.",
        denied: "Studio spending denied.",
      },
    });
    const response = await generate(metered, reason);
    assert.equal(response.status, status);
    assert.equal(
      (await response.json()).error,
      {
        insufficient_credits: "Refill your studio balance.",
        daily_limit_reached: "Studio quota reached.",
        denied: "Studio spending denied.",
      }[reason],
    );
  }
  assert.equal(providerCalls, 1);
  assert.equal(saved.length, 1);
  assert.deepEqual(await owner.erase("studio", "first-picture"), {
    clear: true,
  });
  assert.equal(owner.read(), null);
  console.log(
    "Darkroom packed consumer: catalog, exact save retry, namespace, host refusals, provenance and erasure pass",
  );
} finally {
  await Promise.all(initializations);
  for (const database of databases) database.close();
}

const browser = new MediaGeneration(
  async (method, input) =>
    method === "describe"
      ? {
          computerId: "reader-computer",
          canGenerate: true,
          models: listMediaModels(),
        }
      : method === "cancelAttempt"
        ? null
        : {
            kind: "succeeded",
            result: {
              destination: {
                computerId: "reader-computer",
                path: input.destination.path,
              },
              bytes: 12,
              costMilliunits: 1000,
              format: "png",
              width: 1024,
              height: 768,
              model: settings.model,
            },
          },
  "reader-computer",
);
assert.equal((await browser.describe()).computerId, "reader-computer");
const browserAttempt = await browser.createAttempt();
assert.ok(browserAttempt instanceof MediaGenerationAttempt);
const browserReference = await browserAttempt.reference();
assert.deepEqual(
  await (await browser.restoreAttempt(browserReference)).reference(),
  browserReference,
);
await browser.cancelAttempt(browserReference);
console.log(
  "Darkroom packed browser handle: canonical identity and restored attempt pass",
);

const { port1, port2 } = new MessageChannel();
const hostSession = newMessagePortRpcSession(port1, browser);
const remote = newMessagePortRpcSession(port2);
try {
  const remoteAttempt = await remote.createAttempt();
  try {
    const reference = await remoteAttempt.reference();
    assert.equal(reference.computerId, "reader-computer");
    assert.equal(mediaRequestIds.request.parse(reference.requestId).ok, true);
    const outcome = await remoteAttempt.generate({
      destination: { path: "/prints/fern.png" },
      settings,
    });
    assert.equal(outcome.kind, "succeeded");
    assert.equal(outcome.result.destination.path, "/prints/fern.png");
  } finally {
    remoteAttempt[Symbol.dispose]();
  }
} finally {
  remote[Symbol.dispose]();
  hostSession[Symbol.dispose]();
  port1.close();
  port2.close();
}
console.log(
  "Darkroom packed browser handle: live RPC attempt generation passes",
);
const capabilities = createCapabilityRegistry();
capabilities.provide(mediaGeneration, browser);
const media = await openMediaGeneration(capabilities);
using agarAttempt = await media.restoreAttempt(browserReference);
assert.deepEqual(agarAttempt.reference, browserReference);
const agarResult = await agarAttempt.generate({
  destination: { path: "/prints/fern.png" },
  settings,
});
assert.equal(agarResult.destination.path, "/prints/fern.png");
console.log(
  "Darkroom packed browser handle: unchanged Agar v5 consumer generation passes",
);

const video = validateMediaVideoSelection({
  model: "google/veo-3.1-fast",
  prompt: "a greenhouse at dawn",
});
assert.equal(video.durationSeconds, 6);
assert.equal(video.generateAudio, true);
assert.equal(estimateVideoMilliunits(video), 60_000);
assert.throws(() =>
  validateMediaVideoSelection({
    model: "google/veo-3.1",
    prompt: "a greenhouse at dawn",
    durationSeconds: 5,
  }),
);
