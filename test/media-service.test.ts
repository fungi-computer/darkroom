import { describe, expect, it, vi } from "vitest";
import {
  buildProviderInput,
  getMediaModel,
  listMediaModels,
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_DIMENSION,
  normalizeMediaProviderOutput,
  mediaProviderWireSchema,
  resolveMediaReferences,
  validateMediaGenerationSettings,
  validateMediaVideoSelection,
  mediaVideoModelIdSchema,
  estimateImageMilliunits,
  estimateImageNeurons,
  type MediaReferenceBytes,
} from "../src/index.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const b64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const base = {
  model: "@cf/black-forest-labs/flux-1-schnell",
  prompt: " a quiet room ",
  width: 1024,
  height: 768,
};
const reference: MediaReferenceBytes = {
  bytes: png,
  format: "png",
  width: 8,
  height: 8,
  filename: "ref.png",
};

describe("retained Media model boundary", () => {
  it("exposes thirteen immutable model definitions", () => {
    expect(listMediaModels()).toHaveLength(13);
    expect(listMediaModels().map(({ id }) => id)).toEqual([
      "@cf/black-forest-labs/flux-1-schnell",
      "@cf/black-forest-labs/flux-2-klein-4b",
      "@cf/black-forest-labs/flux-2-klein-9b",
      "@cf/black-forest-labs/flux-2-dev",
      "@cf/leonardo/lucid-origin",
      "@cf/leonardo/phoenix-1.0",
      "openai/gpt-image-2",
      "bytedance/seedance-2.0",
      "bytedance/seedance-2.0-fast",
      "bytedance/seedance-2.0-mini",
      "google/veo-3.1",
      "google/veo-3.1-fast",
      "minimax/h3-max",
    ]);
    expect(Object.isFrozen(listMediaModels())).toBe(true);
    expect(Object.isFrozen(listMediaModels()[0])).toBe(true);
    expect(Object.isFrozen(listMediaModels()[0]?.input)).toBe(true);
  });

  it("keeps each model family's retained dimensions, steps, and references", () => {
    const byId = (id: string) => getMediaModel(id)?.input;
    expect(byId("@cf/black-forest-labs/flux-1-schnell")).toMatchObject({
      transport: "json",
      dimensions: "none",
      steps: "steps",
      maxSteps: 8,
      defaultSteps: 4,
      maxReferences: 0,
    });
    expect(byId("@cf/black-forest-labs/flux-2-klein-4b")).toMatchObject({
      transport: "multipart",
      dimensions: "own",
      maxDimension: 1920,
      maxDimensionDocumented: false,
      steps: "fixed",
      defaultSteps: 4,
      referenceField: "input_image_",
      maxReferences: 4,
    });
    expect(byId("@cf/black-forest-labs/flux-2-klein-9b")).toMatchObject({
      transport: "multipart",
      dimensions: "own",
      maxDimension: 1920,
      maxDimensionDocumented: false,
      steps: "fixed",
      defaultSteps: 4,
      referenceField: "input_image_",
      maxReferences: 4,
    });
    expect(byId("@cf/black-forest-labs/flux-2-dev")).toMatchObject({
      transport: "multipart",
      dimensions: "own",
      steps: "steps",
      maxSteps: null,
      defaultSteps: 20,
      referenceField: "input_image_",
      maxReferences: 4,
    });
    expect(byId("@cf/leonardo/lucid-origin")).toMatchObject({
      transport: "json",
      dimensions: "own",
      maxDimension: 2500,
      maxDimensionDocumented: true,
      steps: "num_steps",
      maxSteps: 40,
      maxReferences: 0,
    });
    expect(byId("@cf/leonardo/phoenix-1.0")).toMatchObject({
      transport: "json",
      dimensions: "own",
      maxDimension: 2048,
      maxDimensionDocumented: true,
      steps: "num_steps",
      maxSteps: 50,
      defaultSteps: 25,
      maxReferences: 0,
    });
  });

  it("normalizes prompts and model defaults while enforcing model limits", () => {
    const phoenix = validateMediaGenerationSettings({
      ...base,
      model: "@cf/leonardo/phoenix-1.0",
      prompt: "  a phoenix  ",
    });
    expect(phoenix).toMatchObject({ prompt: "a phoenix", steps: 25 });
    expect(() =>
      validateMediaGenerationSettings({
        ...base,
        model: "@cf/leonardo/phoenix-1.0",
        width: 2_049,
        height: 1024,
      }),
    ).toThrow(/dimensions/iu);
    expect(() =>
      validateMediaGenerationSettings({
        ...base,
        steps: 9,
      }),
    ).toThrow(/at most 8/iu);
    expect(() =>
      validateMediaGenerationSettings({
        ...base,
        model: "@cf/black-forest-labs/flux-2-klein-4b",
        steps: 3,
      }),
    ).toThrow(/fixed/iu);
    expect(
      validateMediaGenerationSettings({
        ...base,
        model: "@cf/black-forest-labs/flux-2-klein-4b",
      }),
    ).not.toHaveProperty("steps");
    expect(
      validateMediaGenerationSettings({
        ...base,
        model: "@cf/black-forest-labs/flux-2-dev",
        steps: 100,
      }).steps,
    ).toBe(100);
    expect(() =>
      validateMediaGenerationSettings({
        ...base,
        references: [{ computerId: "c", path: "ref.png" }],
      }),
    ).toThrow(/reference/iu);
  });

  it("builds each retained provider payload without inventing fields", () => {
    // Gateway models (fixed sizes) take gatewayInput; see gateway-models.test.
    for (const model of listMediaModels().filter(
      ({ sizes }) => sizes === null,
    )) {
      const settings = validateMediaGenerationSettings({
        ...base,
        model: model.id,
        references:
          model.input.maxReferences === 0
            ? []
            : [{ computerId: "c", path: "ref.png" }],
      });
      const payload = buildProviderInput(
        settings,
        model.input.maxReferences === 0 ? [] : [reference],
      );
      if (payload.transport === "json") {
        expect(payload.body.prompt).toBe("a quiet room");
        if (model.input.dimensions === "none") {
          expect(payload.body).not.toHaveProperty("width");
          expect(payload.body).not.toHaveProperty("height");
        } else {
          expect(payload.body).toMatchObject({ width: 1024, height: 768 });
        }
        if (
          model.input.steps === "num_steps" &&
          model.input.defaultSteps !== null
        )
          expect(payload.body.num_steps).toBeDefined();
      } else {
        expect(payload.body.get("prompt")).toBe("a quiet room");
        expect(payload.body.get("width")).toBe("1024");
        expect(payload.body.get("height")).toBe("768");
        if (model.input.steps === "fixed")
          expect(payload.body.get("steps")).toBeNull();
        if (model.input.maxReferences > 0)
          expect(payload.body.get("input_image_0")).toBeInstanceOf(Blob);
      }
    }
  });
});

describe("deterministic retained image cost", () => {
  it("quotes each retained formula and converts to milliunits", () => {
    expect(
      estimateImageNeurons("@cf/black-forest-labs/flux-1-schnell", {
        width: 1024,
        height: 1024,
        steps: 4,
      }),
    ).toBeCloseTo(57.6, 8);
    expect(
      estimateImageMilliunits("@cf/black-forest-labs/flux-1-schnell", {
        width: 1024,
        height: 1024,
        steps: 4,
      }),
    ).toBe(64);
    expect(
      estimateImageNeurons("@cf/black-forest-labs/flux-2-klein-4b", {
        width: 1024,
        height: 1024,
        references: [{ width: 1024, height: 1024 }],
      }),
    ).toBeCloseTo(125.68, 8);
    expect(
      estimateImageNeurons("@cf/black-forest-labs/flux-2-dev", {
        width: 1024,
        height: 1024,
        steps: 20,
      }),
    ).toBeCloseTo(2981.6, 8);
    expect(
      estimateImageNeurons("@cf/black-forest-labs/flux-2-klein-9b", {
        width: 1024,
        height: 1024,
        references: [{ width: 1024, height: 1024 }],
      }),
    ).toBeCloseTo(1545.46, 8);
    expect(
      estimateImageNeurons("@cf/leonardo/lucid-origin", {
        width: 1024,
        height: 1024,
      }),
    ).toBeCloseTo(2784, 8);
    expect(
      estimateImageNeurons("@cf/leonardo/phoenix-1.0", {
        width: 1024,
        height: 1024,
      }),
    ).toBeCloseTo(2370, 8);
  });

  it("rejects unknown models and hostile parameter values", () => {
    const valid = { width: 512, height: 512 };
    expect(() => estimateImageNeurons("unknown", valid)).toThrow(/unknown/iu);
    for (const params of [
      { width: 0, height: 512 },
      { width: -1, height: 512 },
      { width: Number.NaN, height: 512 },
      { width: 512.5, height: 512 },
      { width: 512, height: Number.POSITIVE_INFINITY },
      { width: 512, height: 512, steps: 0 },
      { width: 512, height: 512, steps: Number.NaN },
      { width: 512, height: 512, references: [{ width: 0, height: 1 }] },
    ])
      expect(() =>
        estimateImageNeurons("@cf/black-forest-labs/flux-1-schnell", params),
      ).toThrow(/invalid/iu);
    expect(() =>
      estimateImageNeurons("@cf/black-forest-labs/flux-1-schnell", {
        ...valid,
        references: [{ width: 512, height: 512 }],
      }),
    ).toThrow(/references/iu);
  });
});

describe("retained Media reference boundary", () => {
  const settings = validateMediaGenerationSettings({
    ...base,
    model: "@cf/black-forest-labs/flux-2-klein-4b",
    references: [{ computerId: "c", path: "ref.png" }],
  });

  it("uses the caller-owned reader and accepts bounded references", async () => {
    const calls: string[] = [];
    const resolved = await resolveMediaReferences(settings, {
      read: (input) => {
        calls.push(`${input.computerId}:${input.path}`);
        return Promise.resolve(reference);
      },
    });
    expect(calls).toEqual(["c:ref.png"]);
    expect(resolved).toEqual([reference]);
  });

  it("rejects oversized dimensions and bytes", async () => {
    await expect(
      resolveMediaReferences(settings, {
        read: () =>
          Promise.resolve({ ...reference, width: MAX_REFERENCE_DIMENSION + 1 }),
      }),
    ).rejects.toThrow(/bounded/iu);
    await expect(
      resolveMediaReferences(settings, {
        read: () =>
          Promise.resolve({
            ...reference,
            bytes: new Uint8Array(MAX_REFERENCE_BYTES + 1),
          }),
      }),
    ).rejects.toThrow(/bounded/iu);
  });

  it.each(mediaVideoModelIdSchema.options)(
    "accepts fitted landscape and portrait video references for %s, not short edges below 320",
    async (id) => {
      const video = validateMediaGenerationSettings({
        ...validateMediaVideoSelection({ model: id, prompt: base.prompt }),
        references: [{ computerId: "c", path: "first.png" }],
      });
      for (const dimensions of [
        { width: 640, height: 320 },
        { width: 320, height: 640 },
      ]) {
        const read = vi.fn(() =>
          Promise.resolve({ ...reference, ...dimensions }),
        );
        await expect(resolveMediaReferences(video, { read })).resolves.toEqual([
          { ...reference, ...dimensions },
        ]);
        expect(read).toHaveBeenCalledWith(video.references?.[0], id);
      }
      for (const dimensions of [
        { width: 512, height: 256 },
        { width: 256, height: 512 },
        { width: 640, height: 319 },
        { width: 0, height: 320 },
      ])
        await expect(
          resolveMediaReferences(video, {
            read: () => Promise.resolve({ ...reference, ...dimensions }),
          }),
        ).rejects.toThrow(/bounded/iu);
    },
  );
});

describe("retained Media provider output boundary", () => {
  it("normalizes binary responses and all retained envelope forms", async () => {
    await expect(
      normalizeMediaProviderOutput(new Response(png)),
    ).resolves.toMatchObject({ format: "png" });
    await expect(
      normalizeMediaProviderOutput(
        mediaProviderWireSchema.parse({
          image: b64(png),
          usage: { input: 1, output: 2 },
        }),
      ),
    ).resolves.toMatchObject({ format: "png" });
    await expect(
      normalizeMediaProviderOutput({
        image: [{ base64: "bad" }, { data: b64(jpeg) }],
      }),
    ).resolves.toMatchObject({ format: "jpeg" });
    await expect(
      normalizeMediaProviderOutput(
        { images: [{ url: "https://provider.invalid/image.webp" }] },
        { fetchUrl: () => Promise.resolve(new Response(png)) },
      ),
    ).resolves.toMatchObject({ format: "png" });
  });

  it("reports failed provider entries and still accepts the next image without leaking provider data", async () => {
    const report = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = new Error("private provider response");
    const fetchUrl = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(new Response(png));
    try {
      await expect(
        normalizeMediaProviderOutput(
          {
            images: [
              { url: "https://provider.invalid/first" },
              { url: "https://provider.invalid/second" },
            ],
          },
          { fetchUrl },
        ),
      ).resolves.toMatchObject({ format: "png" });
      expect(fetchUrl).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenCalledWith(
        "Media service operation failed",
        {
          operation: "provider-entry-fetch",
          errorKind: "error",
        },
        expect.anything(),
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain(
        "private provider response",
      );
    } finally {
      report.mockRestore();
    }
  });

  it("rejects malformed output and keeps URL and encoded bytes unambiguous", async () => {
    expect(() =>
      mediaProviderWireSchema.parse({ result: "no image" }),
    ).toThrow();
    await expect(
      normalizeMediaProviderOutput({
        image: "https://provider.invalid/image.png",
      }),
    ).rejects.toThrow();
    expect(() =>
      mediaProviderWireSchema.parse({
        image: [{ url: "file:///tmp/image.png" }],
      }),
    ).toThrow();
    await expect(
      normalizeMediaProviderOutput(
        { image: [{ url: "https://provider.invalid/image.png" }] },
        {
          fetchUrl: () => Promise.resolve(new Response("not an image")),
        },
      ),
    ).rejects.toThrow(/valid image/iu);
  });

  it("rejects output beyond the caller's byte bound before returning bytes", async () => {
    await expect(
      normalizeMediaProviderOutput({ image: b64(png) }, { maxBytes: 2 }),
    ).rejects.toThrow(/byte bound/iu);
    await expect(
      normalizeMediaProviderOutput(new Response(png), { maxBytes: 2 }),
    ).rejects.toThrow(/byte bound/iu);
  });
});

describe("Workers AI image streams", () => {
  it("normalizes the binding's raw image stream", async () => {
    const stream = new Response(png).body;
    if (stream === null) throw new Error("Missing test response body");
    const output = await normalizeMediaProviderOutput(stream);
    expect(output).toEqual({ bytes: png, format: "png" });
  });

  it("cancels an oversized stream and preserves the bound error", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(png);
      },
      cancel() {
        cancelled = true;
        throw new Error("cleanup failed");
      },
    });
    await expect(
      normalizeMediaProviderOutput(stream, { maxBytes: 4 }),
    ).rejects.toThrow("provider response exceeds the byte bound");
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });
});
