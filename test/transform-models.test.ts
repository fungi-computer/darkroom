import sharp from "sharp";
import * as z from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  getMediaModel,
  listMediaModels,
  resolveMediaReferences,
  validateMediaGenerationSettings,
  type MediaReferenceBytes,
} from "../src/index.js";
import {
  estimateMediaModel,
  generate,
  type MediaAiPort,
} from "../src/cloudflare/provider.js";
import { quoteMediaGeneration } from "../src/media-quote.js";
import { createMediaService } from "../src/server.js";
import { mediaOperationFixture } from "./fixtures/media-operation.fixture.js";

const removeBackground = "bria/remove-background";
const upscale = "pruna/p-image-upscale";
const solid = (
  width: number,
  height: number,
  format: "png" | "jpeg" = "png",
) => {
  const image = sharp({
    create: { width, height, channels: 3, background: "white" },
  });
  return (format === "png" ? image.png() : image.jpeg()).toBuffer();
};
const sourceImage = async (
  width: number,
  height: number,
  format: "png" | "jpeg" | "webp" = "png",
  claimed: { width?: number; height?: number } = {},
): Promise<MediaReferenceBytes> => ({
  bytes: new Uint8Array(
    format === "webp"
      ? await sharp({
          create: { width, height, channels: 3, background: "white" },
        })
          .webp()
          .toBuffer()
      : await solid(width, height, format),
  ),
  format,
  width: claimed.width ?? width,
  height: claimed.height ?? height,
  filename: "source",
});
const reference = [{ computerId: "c", path: "/print.png" }];
type Extra = { width?: number; height?: number; targetMegapixels?: number };
const settings = (model: string, extra: Extra = {}) =>
  validateMediaGenerationSettings({
    model,
    prompt: "Remove background",
    references: reference,
    ...extra,
  });
const reader = (image: MediaReferenceBytes) => ({
  read: () => Promise.resolve(image),
});

const requireModel = (id: string) => {
  const model = listMediaModels().find((entry) => entry.id === id);
  if (model === undefined) throw new Error(`missing ${id}`);
  return model;
};

describe("source-image operations in the catalog", () => {
  it("lists both with their facts, image billing and no prompt-model controls", () => {
    for (const id of [removeBackground, upscale]) {
      const model = getMediaModel(id);
      expect(model?.kind, id).toBe("image");
      expect(model?.billingUnit, id).toBe("image");
      expect(model?.input.maxReferences, id).toBe(1);
      expect(model?.transform?.source, id).toEqual({
        formats: ["png", "jpeg"],
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 25_000_000,
      });
      expect(listMediaModels().map((entry) => entry.id)).toContain(id);
    }
    expect(getMediaModel(removeBackground)?.transform).toMatchObject({
      operation: "remove_background",
      milliunits: 1_800,
      sizes: [],
    });
    expect(getMediaModel(upscale)?.transform).toMatchObject({
      operation: "upscale",
      defaultMegapixels: 4,
      // Cloudflare's published tiers: $0.005 to 4 MP, $0.01 to 8, $0.02 to 16.
      milliunits: null,
      sizes: [
        { megapixels: 4, milliunits: 500 },
        { megapixels: 8, milliunits: 1_000 },
        { megapixels: 16, milliunits: 2_000 },
      ],
    });
  });

  it("takes exactly one source image and only its own settings", () => {
    expect(() =>
      validateMediaGenerationSettings({ model: upscale, prompt: "Upscale" }),
    ).toThrow("exactly one source image");
    expect(() =>
      settings(removeBackground, { width: 512, height: 512 }),
    ).toThrow("takes one source image");
    expect(() => settings(removeBackground, { targetMegapixels: 4 })).toThrow(
      "does not take an output size",
    );
    expect(() => settings(upscale, { targetMegapixels: 5 })).toThrow(
      "accepts output sizes of 4, 8, 16 megapixels",
    );
    expect(settings(upscale).targetMegapixels).toBe(4);
    expect(() =>
      validateMediaGenerationSettings({
        model: "@cf/black-forest-labs/flux-1-schnell",
        prompt: "x",
        width: 512,
        height: 512,
        targetMegapixels: 4,
      }),
    ).toThrow("does not take an output size");
  });

  it("quotes the published price of the chosen output size", async () => {
    const small = await sourceImage(400, 300);
    const quote = (model: string, extra?: Extra) =>
      quoteMediaGeneration(
        { model, prompt: "x", references: reference, ...extra },
        reader(small),
      );
    await expect(quote(removeBackground)).resolves.toMatchObject({
      unit: "image",
      units: 1,
      providerCostMilliunits: 1_800,
    });
    await expect(quote(upscale)).resolves.toMatchObject({
      providerCostMilliunits: 500,
    });
    await expect(
      quote(upscale, { targetMegapixels: 8 }),
    ).resolves.toMatchObject({
      providerCostMilliunits: 1_000,
    });
    await expect(
      quote(upscale, { targetMegapixels: 16 }),
    ).resolves.toMatchObject({
      providerCostMilliunits: 2_000,
    });
  });
});

describe("source validation before any paid call", () => {
  it("refuses WebP, an oversized byte count and too many pixels", async () => {
    await expect(
      resolveMediaReferences(
        settings(removeBackground),
        reader(await sourceImage(64, 64, "webp")),
      ),
    ).rejects.toThrow("takes PNG or JPEG images, not WEBP");
    const huge = await sourceImage(64, 64);
    await expect(
      resolveMediaReferences(
        settings(removeBackground),
        reader({ ...huge, bytes: new Uint8Array(8 * 1024 * 1024 + 1) }),
      ),
    ).rejects.toThrow();
    await expect(
      resolveMediaReferences(
        settings(removeBackground),
        reader({ ...huge, width: 5_001, height: 5_000 }),
      ),
    ).rejects.toThrow("over 25 megapixels");
  });

  it("refuses an upscale whose source is already as large as the output", async () => {
    const big = { ...(await sourceImage(64, 64)), width: 2_000, height: 2_000 };
    await expect(
      resolveMediaReferences(settings(upscale), reader(big)),
    ).rejects.toThrow("already 4.0 megapixels. Choose a larger output");
    await expect(
      resolveMediaReferences(
        settings(upscale, { targetMegapixels: 8 }),
        reader(big),
      ),
    ).resolves.toHaveLength(1);
  });
});

describe("providers", () => {
  const out = async () => new Uint8Array(await solid(8, 8));
  it("sends the source bytes as a data URI and downloads the result", async () => {
    const source = await sourceImage(32, 32);
    const run = vi.fn<MediaAiPort["run"]>(() =>
      Promise.resolve({
        state: "Completed",
        result: { image: "https://provider.example/cut.png" },
      }),
    );
    const ai: MediaAiPort = { run };
    const fetchResult = vi.fn(async () => new Response(await out()));
    const cut = await generate(
      ai,
      settings(removeBackground),
      [source],
      undefined,
      undefined,
      fetchResult,
    );
    expect(cut.format).toBe("png");
    expect(run).toHaveBeenCalledWith(
      removeBackground,
      {
        image: `data:image/png;base64,${Buffer.from(source.bytes).toString("base64")}`,
        preserve_alpha: true,
      },
      undefined,
    );
    await generate(
      ai,
      settings(upscale, { targetMegapixels: 8 }),
      [source],
      undefined,
      undefined,
      fetchResult,
    );
    expect(run).toHaveBeenLastCalledWith(
      upscale,
      expect.objectContaining({ target: 8, output_format: "webp" }),
      undefined,
    );
    const body = z.object({ image: z.string() }).parse(run.mock.lastCall?.[1]);
    expect(body.image.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("charges the estimate, saves the output and reuses it on retry", async () => {
    const fixture = mediaOperationFixture();
    try {
      const source = await sourceImage(32, 32);
      const run = vi.fn(() =>
        Promise.resolve({
          state: "Completed",
          result: { image: "https://provider.example/up.webp" },
        }),
      );
      const fetchResult = async () =>
        new Response(
          new Uint8Array(
            await sharp(await solid(8, 8))
              .webp()
              .toBuffer(),
          ),
        );
      const admit = vi.fn(() => Promise.resolve({ priceMilliunits: 1_500 }));
      const settle = vi.fn(() => Promise.resolve());
      const writes: string[] = [];
      const service = createMediaService({
        scope: {
          actorId: "artist",
          namespace: "studio",
          owner: "prints",
          destinationId: "c",
        },
        operations: { getByName: () => fixture.owner },
        provider: (request, references, signal, format, audio) =>
          generate(
            { run },
            request,
            references,
            signal,
            undefined,
            fetchResult,
            format,
            audio,
          ),
        metering: { admit, settle },
        refusalMessages: {
          insufficient_credits: "Refill",
          denied: "Denied",
          daily_limit_reached: "Daily limit",
        },
        destination: {
          authorize: () => Promise.resolve(),
          remove: () => Promise.resolve("absent" as const),
          write: (path) => {
            writes.push(path);
            return Promise.resolve();
          },
          readReference: () => Promise.resolve(source),
        },
      });
      const post = () =>
        service.request("/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "upscale-retry",
          },
          body: JSON.stringify({
            path: "/print-up.webp",
            settings: {
              model: upscale,
              prompt: "Upscale to 8 MP",
              targetMegapixels: 8,
              references: reference,
            },
          }),
        });
      const first = await post();
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        path: "/print-up.webp",
        // The host's admitted customer price, not the provider cost.
        costMilliunits: 1_500,
        model: upscale,
      });
      const second = await post();
      expect(second.status).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledWith(
        expect.objectContaining({
          units: 1,
          unit: "image",
          providerCostMilliunits: 1_000,
        }),
      );
      expect(settle).toHaveBeenCalledTimes(1);
      expect(writes).toEqual(["/print-up.webp"]);
    } finally {
      fixture.close();
    }
  });

  it("makes no paid call or admission for an unsupported source", async () => {
    const fixture = mediaOperationFixture();
    try {
      const run = vi.fn();
      const admit = vi.fn();
      const service = createMediaService({
        scope: {
          actorId: "artist",
          namespace: "studio",
          owner: "prints",
          destinationId: "c",
        },
        operations: { getByName: () => fixture.owner },
        provider: () => Promise.reject(new Error("unexpected provider call")),
        metering: { admit, settle: () => Promise.resolve() },
        refusalMessages: {
          insufficient_credits: "Refill",
          denied: "Denied",
          daily_limit_reached: "Daily limit",
        },
        destination: {
          authorize: () => Promise.resolve(),
          remove: () => Promise.resolve("absent" as const),
          write: () => Promise.resolve(),
          readReference: async () => sourceImage(64, 64, "webp"),
        },
      });
      const response = await service.request("/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "refuse-webp",
        },
        body: JSON.stringify({
          path: "/cut.png",
          settings: {
            model: removeBackground,
            prompt: "Remove background",
            references: reference,
          },
        }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(run).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });
});

describe("catalog price estimates", () => {
  it("estimates each operation at its default output size", () => {
    expect(
      estimateMediaModel(requireModel(removeBackground)).costMilliunits,
    ).toBe(1_800);
    expect(estimateMediaModel(requireModel(upscale)).costMilliunits).toBe(500);
    // The placeholder reference that satisfies validation is not part of the quote.
    expect(
      estimateMediaModel(requireModel(upscale)).settings,
    ).not.toHaveProperty("references");
  });
});
