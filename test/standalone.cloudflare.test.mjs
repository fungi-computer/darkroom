import { env, exports } from "cloudflare:workers";
import {
  evictDurableObject,
  runInDurableObject,
  abortAllDurableObjects,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { listMediaModels } from "../dist/index.js";
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
  const listed = await catalog.json();
  expect(listed).toHaveLength(listMediaModels().length);
  expect(listed.map((model) => model.billingUnit)).toEqual(
    listMediaModels().map((model) => model.billingUnit),
  );
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

describe("R2 references and destination", () => {
  const referenceModel = "@cf/black-forest-labs/flux-2-klein-4b";
  const referenceKey = "references/greenhouse-ref.gif";
  const marker = "R2-REFERENCE-MARKER";
  const referenceBytes = Uint8Array.from([
    ...imageBytes,
    ...new globalThis.TextEncoder().encode(marker),
  ]);
  const withReference = (path, reference) => ({
    path,
    settings: {
      model: referenceModel,
      prompt: "greenhouse",
      width: 1024,
      height: 768,
      references: [reference],
    },
  });
  const stored = { computerId: "outputs", path: referenceKey };
  const providerCalls = async () => {
    const count = await env.PROOF.get("provider-count");
    return count === null ? 0 : Number(await count.text());
  };

  it("sends a reference image stored in R2 to the provider", async () => {
    await env.OUTPUTS.put(referenceKey, referenceBytes);
    const before = await providerCalls();
    const response = await generate(
      withReference("with-reference.gif", stored),
      "r2-reference-read",
    );
    expect(response.status).toBe(200);
    expect(await providerCalls()).toBe(before + 1);
    const sent = await (await env.PROOF.get("provider-input")).text();
    expect(sent).toContain(marker);
    expect(sent).toContain("greenhouse-ref.gif");
  });

  it("refuses a reference for another destination before dispatch", async () => {
    await env.OUTPUTS.put(referenceKey, referenceBytes);
    // Control: the same reference under the admitted destination id is accepted.
    expect(
      (await generate(withReference("control-b.gif", stored), "r2-control-b"))
        .status,
    ).toBe(200);
    const before = await providerCalls();
    const response = await generate(
      withReference("wrong-destination.gif", {
        ...stored,
        computerId: "someone-else",
      }),
      "r2-reference-wrong-destination",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ stage: "settings" });
    expect(await providerCalls()).toBe(before);
    expect(await env.OUTPUTS.get("wrong-destination.gif")).toBeNull();
  });

  it("refuses a missing or oversized reference before dispatch", async () => {
    await env.OUTPUTS.put(referenceKey, referenceBytes);
    // Control: a stored, in-limit reference is accepted by the same host.
    expect(
      (await generate(withReference("control-c.gif", stored), "r2-control-c"))
        .status,
    ).toBe(200);
    await env.OUTPUTS.put(
      "references/too-big.gif",
      new Uint8Array(8 * 1024 * 1024 + 1),
    );
    const before = await providerCalls();
    for (const [id, path] of [
      ["r2-reference-missing", "references/absent.gif"],
      ["r2-reference-oversized", "references/too-big.gif"],
    ]) {
      const response = await generate(
        withReference(`${id}.gif`, { computerId: "outputs", path }),
        id,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ stage: "settings" });
      expect(await providerCalls()).toBe(before);
      expect(await env.OUTPUTS.get(`${id}.gif`)).toBeNull();
    }
  });

  it("saves the output at the requested key and reuses it on retry", async () => {
    await env.OUTPUTS.put(referenceKey, referenceBytes);
    const input = withReference("results/from-reference.gif", stored);
    const before = await providerCalls();
    expect((await generate(input, "r2-output-retry")).status).toBe(200);
    const object = await env.OUTPUTS.get("results/from-reference.gif");
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(imageBytes);
    expect(object.httpMetadata.contentType).toBe("image/gif");
    expect(await providerCalls()).toBe(before + 1);
    expect((await generate(input, "r2-output-retry")).status).toBe(200);
    expect(await providerCalls()).toBe(before + 1);
  });
});
