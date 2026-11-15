import type {
  MediaReference,
  MediaReferenceBytes,
  ReferenceImageFitter,
} from "../index.js";
import { MediaSettingsError } from "../model-catalog.js";
import { mediaContentType } from "../media-content-type.js";
import {
  readHostReference,
  referenceFilename,
  type HostReferenceSource,
} from "../reference-read.js";
import { mediaPathSchema } from "../media-path.js";
import type { MediaServiceHost } from "../server.js";

/** The R2 bucket operations a Media destination needs; a native `R2Bucket` satisfies it. */
export type MediaR2Bucket = {
  /** Read one object, or null when the key is absent. */
  get(key: string): Promise<
    | (Readonly<{
        /** Stored byte length. */ size: number;
      }> & {
        /** Load the stored bytes. */ arrayBuffer(): Promise<ArrayBuffer>;
      })
    | null
  >;
  /** Store exact bytes with their MIME type. */
  put(
    key: string,
    bytes: Uint8Array,
    options: Readonly<{
      /** MIME type recorded on the object. */
      httpMetadata: Readonly<{ /** MIME type. */ contentType: string }>;
    }>,
  ): Promise<object | null>;
};

/** Host-owned R2 destination configuration. */
export type R2MediaDestinationOptions = Readonly<{
  /** The bucket holding reference images and generated output. */
  bucket: MediaR2Bucket;
  /**
   * The destination identity the host admitted. A reference must carry this
   * same value (in `MediaReference.computerId`) or it is refused.
   */
  destinationId: string;
  /** The Images-binding reference fitter, from `createImagesReferenceFitter`. */
  fit: ReferenceImageFitter;
  /**
   * The host's own permission check for one object key. It runs before every
   * dispatch, write and reference read; throw to refuse. Omitted, any valid
   * key in `bucket` is allowed.
   */
  authorize?: ((key: string) => Promise<void> | void) | undefined;
}>;

/** The host destination over an R2 bucket, with both reference readers present. */
export type R2MediaDestination = MediaServiceHost["destination"] &
  Readonly<{
    /** Authorize, read and fit one reference image for the catalog model. */
    readReference: (
      reference: MediaReference,
      model: string,
    ) => Promise<MediaReferenceBytes>;
    /** Authorize and read the raw bytes of one reference audio clip. */
    readAudioReference: (reference: MediaReference) => Promise<Uint8Array>;
  }>;

/**
 * A Media destination over one R2 bucket: object keys are the paths, validated
 * with Darkroom's path schema. Never accepts URLs.
 */
export function createR2MediaDestination(
  options: R2MediaDestinationOptions,
): R2MediaDestination {
  const { bucket, destinationId, fit } = options;
  const authorize = async (key: string): Promise<void> => {
    const parsed = mediaPathSchema.safeParse(key);
    if (!parsed.success)
      throw new MediaSettingsError("R2 object key is not a valid path");
    await options.authorize?.(parsed.data);
  };
  const read = (kind: "image" | "audio", reference: MediaReference) =>
    readHostReference({
      reference,
      destinationId,
      kind,
      open: async (key): Promise<HostReferenceSource | null> => {
        await authorize(key);
        const object = await bucket.get(key);
        if (object === null) return null;
        return {
          size: object.size,
          bytes: async () => new Uint8Array(await object.arrayBuffer()),
        };
      },
    });
  return {
    authorize,
    write: async (key, bytes) => {
      await authorize(key);
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: mediaContentType(bytes) },
      });
    },
    readReference: async (reference, model) => ({
      ...(await fit(await read("image", reference), model)),
      filename: referenceFilename(reference),
    }),
    readAudioReference: (reference) => read("audio", reference),
  };
}
