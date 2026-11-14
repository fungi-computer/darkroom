import { z } from "zod";
import {
  MAX_REFERENCE_BYTES,
  MediaSettingsError,
  viewDimensionSchema,
  type ImageViewFitter,
  type ReferenceImageFitter,
} from "../index.js";
import {
  referenceImageFormat,
  referenceImageTransform,
} from "../reference-image-size.js";

/** WebP quality for lossy references; visually near-lossless at a fraction of PNG's bytes. */
const REFERENCE_WEBP_QUALITY = 85;

/** The retained `read_image` encoding: JPEG at quality 80. */
const VIEW_JPEG_QUALITY = 80;

const metadata = z.lazy(() =>
  z.object({
    format: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
);
const formats = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

/**
 * Cloudflare answers the Images binding with error 9432 ("not available using
 * legacy billing") when the account has not moved to the current billing
 * model. Say what to do, not the raw binding failure.
 */
export const imagesLegacyBillingMessage =
  "Cloudflare Images is not available on this Cloudflare account because it is on legacy billing (Cloudflare error 9432). Reference images need the Images binding. Update the account's billing in the Cloudflare dashboard, or generate without reference images.";

/** The Images binding's `ImagesError` carries Cloudflare's numeric error code. */
const legacyBillingFailure = z.object({ code: z.literal(9432) });

function legacyBillingRefusal(cause: unknown): MediaSettingsError | undefined {
  return legacyBillingFailure.safeParse(cause).success
    ? new MediaSettingsError(imagesLegacyBillingMessage)
    : undefined;
}

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
    /** Apply the native aspect-preserving resize. */
    transform(options: {
      /** Image width in pixels. */
      width: number;
      /** Image height in pixels. */
      height: number;
      fit: "scale-down" | "contain";
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
            }
          | {
              /** Actual output encoding. */
              format: "image/webp";
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
 * fit the selected model's reference size in its catalog encoding, then decode
 * the output so its metadata describes the bytes actually sent.
 */
export function createImagesReferenceFitter(
  images: MediaImagePort,
): ReferenceImageFitter {
  return async (input, model) => {
    let bytes = input;
    let info: z.output<typeof metadata>;
    try {
      info = metadata.parse(await images.info(stream(bytes)));
    } catch (cause) {
      // Other Images failure detail is never surfaced; the caller's bytes are.
      throw (
        legacyBillingRefusal(cause) ??
        new MediaSettingsError("reference image is not a supported image")
      );
    }
    const transform = referenceImageTransform(model, info.width, info.height);
    const target = referenceImageFormat(model);
    if (
      info.width !== transform.width ||
      info.height !== transform.height ||
      (target === "image/webp" && info.format !== target)
    ) {
      const output = await images
        .input(stream(bytes))
        .transform(transform)
        .output(
          target === "image/webp"
            ? { format: target, quality: REFERENCE_WEBP_QUALITY }
            : { format: target },
        )
        .catch((cause: unknown) => {
          throw legacyBillingRefusal(cause) ?? cause;
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
    } catch (cause) {
      // Other Images failure detail is never surfaced.
      throw (
        legacyBillingRefusal(cause) ??
        new MediaSettingsError("image is not a supported image")
      );
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
