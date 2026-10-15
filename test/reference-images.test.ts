import { describe, expect, it, vi } from "vitest";
import {
  createImagesReferenceFitter,
  createImagesViewFitter,
} from "../src/cloudflare/reference-images.js";

const source = new Uint8Array([1, 2, 3]);
const resized = new Uint8Array([4, 5]);

describe("Images reference fitting", () => {
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
    await expect(fit(source)).resolves.toEqual({
      bytes: resized,
      format: "png",
      width: 512,
      height: 256,
    });
    expect(transform).toHaveBeenCalledWith({
      width: 512,
      height: 512,
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
    await expect(fit(source)).resolves.toEqual({
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
    await expect(fit(source)).rejects.toThrow();
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
