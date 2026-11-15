import { describe, expect, it, vi } from "vitest";
import {
  MAX_AUDIO_REFERENCE_BYTES,
  MAX_REFERENCE_BYTES,
  MediaSettingsError,
  type ReferenceImageFitter,
} from "../src/index.js";
import {
  createR2MediaDestination,
  type MediaR2Bucket,
} from "../src/cloudflare/r2-destination.js";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
]);

function fixture(authorize?: (key: string) => Promise<void> | void) {
  const objects = new Map<string, { bytes: Uint8Array; size: number }>();
  const put = vi.fn((key: string, bytes: Uint8Array) => {
    objects.set(key, { bytes, size: bytes.byteLength });
    return Promise.resolve(null);
  });
  const bucket: MediaR2Bucket = {
    get: (key) => {
      const object = objects.get(key);
      return Promise.resolve(
        object === undefined
          ? null
          : {
              size: object.size,
              arrayBuffer: () => Promise.resolve(object.bytes.slice().buffer),
            },
      );
    },
    put,
  };
  const fit = vi.fn<ReferenceImageFitter>((bytes) =>
    Promise.resolve({ bytes, format: "png", width: 1, height: 1 }),
  );
  const destination = createR2MediaDestination({
    bucket,
    destinationId: "bucket-a",
    fit,
    authorize,
  });
  return { objects, put, fit, destination };
}
const reference = { computerId: "bucket-a", path: "refs/cat.png" };

describe("createR2MediaDestination", () => {
  it("fits a stored reference and names it after the key", async () => {
    const { objects, fit, destination } = fixture();
    objects.set("refs/cat.png", { bytes: png, size: png.byteLength });
    await expect(
      destination.readReference(reference, "model-a"),
    ).resolves.toEqual({
      bytes: png,
      format: "png",
      width: 1,
      height: 1,
      filename: "cat.png",
    });
    expect(fit).toHaveBeenCalledExactlyOnceWith(png, "model-a");
  });

  it("refuses another destination, a missing key, an empty object and an oversized one", async () => {
    const { objects, fit, destination } = fixture();
    objects.set("refs/empty.png", { bytes: new Uint8Array(), size: 0 });
    // Size is checked from object metadata, so the oversized body is never loaded.
    objects.set("refs/big.png", {
      bytes: png,
      size: MAX_AUDIO_REFERENCE_BYTES + 1,
    });
    const refused = [
      { ...reference, computerId: "bucket-b" },
      { ...reference, path: "refs/absent.png" },
      { ...reference, path: "refs/empty.png" },
      { ...reference, path: "refs/big.png" },
    ];
    for (const item of refused) {
      await expect(destination.readReference(item, "model-a")).rejects.toThrow(
        MediaSettingsError,
      );
      await expect(destination.readAudioReference(item)).rejects.toThrow(
        MediaSettingsError,
      );
    }
    expect(fit).not.toHaveBeenCalled();
  });

  it("refuses an image just over the image limit but not an audio clip", async () => {
    const { objects, fit, destination } = fixture();
    objects.set("refs/mid", { bytes: png, size: MAX_REFERENCE_BYTES + 1 });
    const mid = { ...reference, path: "refs/mid" };
    await expect(destination.readReference(mid, "model-a")).rejects.toThrow(
      MediaSettingsError,
    );
    await expect(destination.readAudioReference(mid)).resolves.toEqual(png);
    expect(fit).not.toHaveBeenCalled();
  });

  it("reads audio bytes without fitting", async () => {
    const { objects, fit, destination } = fixture();
    objects.set("refs/clip.mp3", { bytes: png, size: png.byteLength });
    await expect(
      destination.readAudioReference({ ...reference, path: "refs/clip.mp3" }),
    ).resolves.toEqual(png);
    expect(fit).not.toHaveBeenCalled();
  });

  it("writes the exact bytes with a content type from the bytes", async () => {
    const { put, destination } = fixture();
    await destination.write("out/a.png", png);
    expect(put).toHaveBeenCalledExactlyOnceWith("out/a.png", png, {
      httpMetadata: { contentType: "image/png" },
    });
  });

  it("refuses URLs-as-keys that are not valid paths and runs the host check first", async () => {
    const authorize = vi.fn((key: string) => {
      if (key.startsWith("private/")) throw new Error("denied");
    });
    const { put, destination } = fixture(authorize);
    await expect(destination.authorize("")).rejects.toThrow(MediaSettingsError);
    await expect(destination.authorize("a\0b")).rejects.toThrow(
      MediaSettingsError,
    );
    await expect(destination.authorize("out/ok.png")).resolves.toBeUndefined();
    await expect(destination.write("private/x.png", png)).rejects.toThrow(
      "denied",
    );
    await expect(
      destination.readReference(
        { ...reference, path: "private/x.png" },
        "model-a",
      ),
    ).rejects.toThrow("denied");
    expect(put).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith("out/ok.png");
  });
});
