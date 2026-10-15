import { z } from "zod";
import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_DIMENSION,
  MediaSettingsError,
  viewDimensionSchema,
  type ImageViewFitter,
  type ReferenceImageFitter,
} from "../index.js";

/** The retained `read_image` encoding: JPEG at quality 80. */
const VIEW_JPEG_QUALITY = 80;

const metadata = z.object({
  format: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const formats = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });

/** Only image metadata and the bounded resize chain are consumed by Media. */
export type MediaImagePort = {
  /** Read decoded image metadata through the Images binding. */
  info(input: ReadableStream<Uint8Array>): ReturnType<ImagesBinding["info"]>;
  /** Start the native resize and encode chain. */
  input(input: ReadableStream<Uint8Array>): {
    /** Apply the native scale-down transform. */
    transform(options: {
      /** Image width in pixels. */
      width: number;
      /** Image height in pixels. */
      height: number;
      fit: "scale-down";
    }): {
      /** Encode the transformed image through the native Images binding. */
      output(
        options:
          | {
              /** Actual output encoding. */
              format: "image/png";
            }
          | {
              /** Actual output encoding. */
              format: "image/jpeg";
              quality: number;
            },
      ): Promise<{
        /** Provider response or encoded image response. */
        response(): Response;
      }>;
    };
  };
};

/**
 * Media's reference preparation on the Images binding: decode the real bytes,
 * scale an oversized image down to MAX_REFERENCE_DIMENSION as PNG, then decode
 * the output so its metadata describes the bytes actually sent.
 */
export function createImagesReferenceFitter(
  images: MediaImagePort,
): ReferenceImageFitter {
  return async (input) => {
    let bytes = input;
    let info: z.output<typeof metadata>;
    try {
      info = metadata.parse(await images.info(stream(bytes)));
    } catch {
      // The Images failure detail is never surfaced; the caller's bytes are.
      throw new MediaSettingsError("reference image is not a supported image");
    }
    if (
      info.width > MAX_REFERENCE_DIMENSION ||
      info.height > MAX_REFERENCE_DIMENSION
    ) {
      const output = await images
        .input(stream(bytes))
        .transform({
          width: MAX_REFERENCE_DIMENSION,
          height: MAX_REFERENCE_DIMENSION,
          fit: "scale-down",
        })
        .output({
          format: "image/png",
        });
      bytes = new Uint8Array(await output.response().arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_REFERENCE_BYTES)
        throw new MediaSettingsError("reference image exceeds the byte limit");
      info = metadata.parse(await images.info(stream(bytes)));
    }
    return {
      bytes,
      format: formats[info.format],
      width: info.width,
      height: info.height,
    };
  };
}

/**
 * Fit one image for a model to look at on the Images binding: always
 * re-encode it as JPEG (quality 80), scaled down within `maxDimension`, and
 * decode the output so its metadata describes the bytes actually returned.
 */
export function createImagesViewFitter(
  images: MediaImagePort,
): ImageViewFitter {
  return async (input, maxDimension) => {
    const bound = viewDimensionSchema.safeParse(maxDimension);
    if (!bound.success)
      throw new MediaSettingsError("view dimension is out of bounds");
    try {
      metadata.parse(await images.info(stream(input)));
    } catch {
      // The Images failure detail is never surfaced.
      throw new MediaSettingsError("image is not a supported image");
    }
    const output = await images
      .input(stream(input))
      .transform({
        width: bound.data,
        height: bound.data,
        fit: "scale-down",
      })
      .output({
        format: "image/jpeg",
        quality: VIEW_JPEG_QUALITY,
      });
    const bytes = new Uint8Array(await output.response().arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_REFERENCE_BYTES)
      throw new MediaSettingsError("image exceeds the byte limit");
    const info = metadata.parse(await images.info(stream(bytes)));
    return {
      bytes,
      format: formats[info.format],
      width: info.width,
      height: info.height,
    };
  };
}
