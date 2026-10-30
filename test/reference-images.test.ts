import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  resolveMediaReferences,
  validateMediaGenerationSettings,
  type MediaReference,
  type FittedReferenceImage,
} from "../src/index.js";
import { createMediaService } from "../src/server.js";
import { MediaBillingRefusal } from "../src/execution-error.js";
import { mediaOperationFixture } from "./fixtures/media-operation.fixture.js";
import {
  createImagesReferenceFitter,
  createImagesViewFitter,
  type MediaImagePort,
} from "../src/cloudflare/reference-images.js";

const source = new Uint8Array([1, 2, 3]);
const resized = new Uint8Array([4, 5]);
const imageModel = "@cf/black-forest-labs/flux-2-klein-4b";
const videoModel = "bytedance/seedance-2.0-mini";

/** Local Images adapter with real pixel decoding/resizing, never inference. */
const pixelImages: MediaImagePort = {
  info: async (input) => {
    const bytes = await new Response(input).arrayBuffer();
    const info = await sharp(bytes).metadata();
    return {
      format: "image/png",
      width: info.width,
      height: info.height,
      fileSize: bytes.byteLength,
    };
  },
  input: (input) => ({
    transform: (options) => ({
      output: async () => {
        const bytes = await sharp(await new Response(input).arrayBuffer())
          .resize({
            width: options.width,
            height: options.height,
            fit: "inside",
            withoutEnlargement: options.fit === "scale-down",
          })
          .png()
          .toBuffer();
        return { response: () => new Response(new Uint8Array(bytes)) };
      },
    }),
  }),
};

describe("Images reference fitting", () => {
  it("passes the selected video model through the real generation service before billing", async () => {
    const fixture = mediaOperationFixture();
    try {
      const bytes = await sharp({
        create: { width: 1774, height: 887, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      const fit = createImagesReferenceFitter(pixelImages);
      const prepared: FittedReferenceImage[] = [];
      const readReference = vi.fn(
        async (_reference: MediaReference, model: string) => {
          const fitted = await fit(new Uint8Array(bytes), model);
          prepared.push(fitted);
          return fitted;
        },
      );
      const provider = vi.fn(() =>
        Promise.reject(new Error("Unexpected provider call")),
      );
      const admit = vi.fn(() =>
        Promise.reject(new MediaBillingRefusal("insufficient_credits")),
      );
      const service = createMediaService({
        scope: {
          actorId: "artist",
          namespace: "studio",
          owner: "prints",
          destinationId: "c",
        },
        operations: { getByName: () => fixture.owner },
        provider,
        metering: { admit, settle: () => Promise.resolve() },
        refusalMessages: {
          insufficient_credits: "Refill",
          daily_limit_reached: "Quota",
          denied: "Denied",
        },
        destination: {
          authorize: () => Promise.resolve(),
          write: () => Promise.resolve(),
          readReference,
        },
      });
      const response = await service.request("/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "first-frame-sizing",
        },
        body: JSON.stringify({
          path: "/video.mp4",
          settings: {
            model: videoModel,
            prompt: "Animate the first frame",
            width: 1280,
            height: 720,
            references: [
              { computerId: "c", path: "/first.png", role: "first-frame" },
            ],
          },
        }),
      });
      expect(response.status).toBe(402);
      expect(readReference).toHaveBeenCalledExactlyOnceWith(
        { computerId: "c", path: "/first.png", role: "first-frame" },
        videoModel,
      );
      const fitted = prepared[0];
      if (fitted === undefined) throw new Error("Missing prepared first frame");
      await expect(sharp(fitted.bytes).metadata()).resolves.toMatchObject({
        width: 640,
        height: 320,
      });
      expect(admit).toHaveBeenCalledOnce();
      expect(provider).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  it.each([
    {
      name: "1774x887 video",
      model: videoModel,
      width: 1774,
      height: 887,
      expected: { width: 640, height: 320 },
    },
    {
      name: "887x1774 video",
      model: videoModel,
      width: 887,
      height: 1774,
      expected: { width: 320, height: 640 },
    },
    {
      name: "1774x887 image",
      model: imageModel,
      width: 1774,
      height: 887,
      expected: { width: 512, height: 256 },
    },
    {
      name: "887x1774 image",
      model: imageModel,
      width: 887,
      height: 1774,
      expected: { width: 256, height: 512 },
    },
    {
      name: "small video",
      model: videoModel,
      width: 200,
      height: 100,
      expected: { width: 640, height: 320 },
    },
    {
      name: "small image",
      model: imageModel,
      width: 200,
      height: 100,
      expected: { width: 200, height: 100 },
    },
    {
      name: "already fitted video",
      model: videoModel,
      width: 640,
      height: 320,
      expected: { width: 640, height: 320 },
    },
  ])(
    "fits $name references using actual decoded pixels",
    async ({ model, width, height, expected }) => {
      const bytes = await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: "white",
        },
      })
        .png()
        .toBuffer();
      const settings = validateMediaGenerationSettings({
        model,
        prompt: "Animate this first frame",
        width: 1280,
        height: 720,
        references: [{ computerId: "c", path: "/first.png" }],
      });
      const fit = createImagesReferenceFitter(pixelImages);
      const [reference] = await resolveMediaReferences(settings, {
        read: async (_reference, model) => fit(new Uint8Array(bytes), model),
      });
      if (reference === undefined) throw new Error("Missing fitted reference");
      const decoded = await sharp(reference.bytes).metadata();
      expect(decoded).toMatchObject(expected);
      expect(reference).toMatchObject(expected);
    },
  );

  it("scales an oversized image and uses decoded output metadata", async () => {
    const info = vi
      .fn<ImagesBinding["info"]>()
      .mockResolvedValueOnce({
        format: "image/jpeg",
        width: 2048,
        height: 1024,
        fileSize: source.byteLength,
      })
      .mockResolvedValueOnce({
        format: "image/png",
        width: 512,
        height: 256,
        fileSize: resized.byteLength,
      });
    const transform = vi.fn(() => transformer);
    const output = vi.fn(() =>
      Promise.resolve({
        response: () => new Response(resized),
        image: () => new Blob([resized]).stream(),
        contentType: () => "image/png",
      }),
    );
    const transformer: ImageTransformer = {
      transform,
      output,
      draw: () => {
        throw new Error("Unexpected draw");
      },
    };
    const fit = createImagesReferenceFitter({
      info,
      input: vi.fn(() => transformer),
    });
    await expect(fit(source, imageModel)).resolves.toEqual({
      bytes: resized,
      format: "png",
      width: 512,
      height: 256,
    });
    expect(transform).toHaveBeenCalledWith({
      width: 512,
      height: 256,
      fit: "scale-down",
    });
    expect(output).toHaveBeenCalledWith({ format: "image/png" });
    expect(info).toHaveBeenCalledTimes(2);
    const first = info.mock.calls[0]?.[0];
    const second = info.mock.calls[1]?.[0];
    expect(new Uint8Array(await new Response(first).arrayBuffer())).toEqual(
      source,
    );
    expect(new Uint8Array(await new Response(second).arrayBuffer())).toEqual(
      resized,
    );
  });

  it("keeps an image within the bound unchanged", async () => {
    const fit = createImagesReferenceFitter({
      info: vi.fn(() =>
        Promise.resolve({
          format: "image/webp" as const,
          width: 64,
          height: 32,
          fileSize: source.byteLength,
        }),
      ),
      input: () => {
        throw new Error("Unexpected transform");
      },
    });
    await expect(fit(source, imageModel)).resolves.toEqual({
      bytes: source,
      format: "webp",
      width: 64,
      height: 32,
    });
  });

  it("rejects unsupported or missing metadata without inventing dimensions", async () => {
    const fit = createImagesReferenceFitter({
      info: vi.fn(() => Promise.resolve({ format: "image/svg+xml" as const })),
      input: () => {
        throw new Error("Unexpected transform");
      },
    });
    await expect(fit(source, imageModel)).rejects.toThrow();
  });
});

describe("Images view fitting", () => {
  it("always re-encodes as JPEG within the requested bound", async () => {
    const info = vi
      .fn<ImagesBinding["info"]>()
      .mockResolvedValueOnce({
        format: "image/png",
        width: 64,
        height: 32,
        fileSize: source.byteLength,
      })
      .mockResolvedValueOnce({
        format: "image/jpeg",
        width: 64,
        height: 32,
        fileSize: resized.byteLength,
      });
    const transform = vi.fn(() => transformer);
    const output = vi.fn(() =>
      Promise.resolve({
        response: () => new Response(resized),
        image: () => new Blob([resized]).stream(),
        contentType: () => "image/jpeg",
      }),
    );
    const transformer: ImageTransformer = {
      transform,
      output,
      draw: () => {
        throw new Error("Unexpected draw");
      },
    };
    const fit = createImagesViewFitter({
      info,
      input: vi.fn(() => transformer),
    });
    await expect(fit(source, 384)).resolves.toEqual({
      bytes: resized,
      format: "jpeg",
      width: 64,
      height: 32,
    });
    expect(transform).toHaveBeenCalledWith({
      width: 384,
      height: 384,
      fit: "scale-down",
    });
    expect(output).toHaveBeenCalledWith({ format: "image/jpeg", quality: 80 });
  });

  it("refuses a dimension outside Media's view bound", async () => {
    const fit = createImagesViewFitter({
      info: () => {
        throw new Error("Unexpected info");
      },
      input: () => {
        throw new Error("Unexpected transform");
      },
    });
    await expect(fit(source, 1_024)).rejects.toThrow("out of bounds");
    await expect(fit(source, 128)).rejects.toThrow("out of bounds");
  });
});
