import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runInDurableObject,
  abortAllDurableObjects,
} from "cloudflare:test";
import { expect, it } from "vitest";
import { imageBytes } from "./standalone.worker.mjs";

const requestId = "standalone-retry";
const body = {
  path: "greenhouse.gif",
  settings: {
    model: "@cf/black-forest-labs/flux-1-schnell",
    prompt: "greenhouse",
    width: 1024,
    height: 768,
    steps: 4,
  },
};
async function request(path, options = {}) {
  const response = await exports.default.fetch(
    new globalThis.Request(`https://media.invalid${path}`, {
      ...options,
      headers: {
        Authorization: "Bearer local-media-proof",
        ...options.headers,
      },
    }),
  );
  return new globalThis.Response(await response.arrayBuffer(), {
    status: response.status,
    headers: response.headers,
  });
}
function generate(value = body, id = requestId) {
  return request("/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": id },
    body: JSON.stringify(value),
  });
}

it("retains native output across DO eviction and retries without another provider call", async () => {
  expect(
    (
      await exports.default.fetch(
        new globalThis.Request("https://media.invalid/models"),
      )
    ).status,
  ).toBe(401);
  const catalog = await request("/models");
  expect(catalog.status).toBe(200);
  expect(await catalog.json()).toHaveLength(13);
  expect(
    (await request("/generate", { method: "POST", body: "{" })).status,
  ).toBe(400);
  expect(await env.PROOF.get("provider-count")).toBeNull();

  await env.PROOF.put("fail-next-save", "yes");
  const failed = await generate();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({
    stage: "destination-write",
    retryable: true,
  });
  expect(await env.OUTPUTS.get(body.path)).toBeNull();
  expect(await (await env.PROOF.get("provider-count")).text()).toBe("1");
  const operation = env.MEDIA_OPERATION.getByName(`media:${requestId}`);
  const retained = await env.APP_ARTIFACTS.get(
    `media-output/v1/media:${requestId}`,
  );
  expect(new Uint8Array(await retained.arrayBuffer())).toEqual(imageBytes);
  await evictDurableObject(operation);
  await evictDurableObject(env.MEDIA_HOST.getByName("media"));

  const retry = await generate();
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({
    path: body.path,
    bytes: imageBytes.byteLength,
    format: "gif",
  });
  expect(await (await env.PROOF.get("provider-count")).text()).toBe("1");
  const saved = await request(`/object?key=${encodeURIComponent(body.path)}`);
  expect(saved.status).toBe(200);
  expect(new Uint8Array(await saved.arrayBuffer())).toEqual(imageBytes);
  expect((await generate()).status).toBe(200);
  expect(await (await env.PROOF.get("provider-count")).text()).toBe("1");
  const conflict = await generate({
    ...body,
    settings: { ...body.settings, prompt: "a different request" },
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({
    stage: "operation",
    retryable: false,
  });
  expect(await (await env.PROOF.get("provider-count")).text()).toBe("1");
});

it("adopts native output after acknowledgement loss and owner restart", async () => {
  const id = "standalone-output-gap";
  const input = { ...body, path: "recovered-greenhouse.gif" };
  const before = await env.PROOF.get("provider-count");
  const expectedCalls = (before === null ? 0 : Number(await before.text())) + 1;
  await env.PROOF.put("fail-next-output-ack", "yes");
  expect((await generate(input, id)).status).toBe(503);
  const operation = env.MEDIA_OPERATION.getByName(`media:${id}`);
  expect(await operation.read()).toMatchObject({
    state: "generating",
    image: null,
  });
  const retained = await env.APP_ARTIFACTS.get(`media-output/v1/media:${id}`);
  expect(new Uint8Array(await retained.arrayBuffer())).toEqual(imageBytes);
  expect(await env.OUTPUTS.get(input.path)).toBeNull();
  // Advance the persisted lease to the crash-recovery boundary without a production test API.
  await runInDurableObject(operation, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE hub_media_operation SET lease_expires_at=0 WHERE singleton=1",
    );
  });
  await abortAllDurableObjects();
  const recovered = await generate(input, id);
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({
    path: input.path,
    bytes: imageBytes.byteLength,
    format: "gif",
  });
  const saved = await env.OUTPUTS.get(input.path);
  expect(new Uint8Array(await saved.arrayBuffer())).toEqual(imageBytes);
  expect(await (await env.PROOF.get("provider-count")).text()).toBe(
    String(expectedCalls),
  );
  expect((await generate(input, id)).status).toBe(200);
  expect(await (await env.PROOF.get("provider-count")).text()).toBe(
    String(expectedCalls),
  );
});

it("embeds real PNG, JPEG and transparent WebP inside workerd", async () => {
  const { embedProvenance } = await import("../dist/provenance.js");
  const { images } = await import("./provenance-images.fixture.mjs");
  for (const image of images) {
    const bytes = Uint8Array.from(globalThis.atob(image.base64), (value) =>
      value.charCodeAt(0),
    );
    const result = await embedProvenance(bytes, image.format, {
      printId: "native-provenance-proof",
      model: "flux-native-proof",
      prompt: "mushroom & moon",
      createdAt: 1_770_000_000_000,
    });
    expect(result.embedded).toBe(true);
    expect(new globalThis.TextDecoder().decode(result.bytes)).toContain(
      "native-provenance-proof",
    );
  }
});

it("writes enriched bytes through the actual generation destination and reports their size", async () => {
  const { images } = await import("./provenance-images.fixture.mjs");
  const image = images.find((image) => image.format === "png");
  expect(image).toBeDefined();
  const original = Uint8Array.from(globalThis.atob(image.base64), (value) =>
    value.charCodeAt(0),
  );
  await env.PROOF.put("provider-image", original);
  try {
    const id = "native-enriched-write";
    const path = "enriched.png";
    const response = await generate({ ...body, path }, id);
    expect(response.status).toBe(200);
    const result = await response.json();
    const saved = await request(`/object?key=${path}`);
    const output = new Uint8Array(await saved.arrayBuffer());
    expect(result.bytes).toBe(output.byteLength);
    expect(output.byteLength).toBeGreaterThan(original.byteLength);
    expect(new globalThis.TextDecoder().decode(output)).toContain(id);
    const retained = await env.APP_ARTIFACTS.get(`media-output/v1/media:${id}`);
    expect(new Uint8Array(await retained.arrayBuffer())).toEqual(original);
    const replay = await generate({ ...body, path }, id);
    expect(replay.status).toBe(200);
    expect(
      new Uint8Array(
        await (await request(`/object?key=${path}`)).arrayBuffer(),
      ),
    ).toEqual(output);
  } finally {
    await env.PROOF.delete("provider-image");
  }
});
