import { z } from "zod";

/** A result URL every gateway provider must return as plain HTTPS. */
export const resultUrl = z.lazy(() =>
  z
    .url()
    .refine(
      (value) => value.startsWith("https://"),
      "result URLs must be HTTPS",
    ),
);

/** The Unified AI gateway's normalized answer: a completed state and one
 * result URL. Seedance and Veo answer this way; MiniMax does not. */
export const gatewayOutputSchema = z.lazy(() =>
  z.looseObject({
    state: z.literal("Completed").optional(),
    result: z.looseObject({
      image: resultUrl.optional(),
      video: resultUrl.optional(),
    }),
  }),
);

/** Byte ceilings for fetched results; video stays within Worker memory. */
export const GATEWAY_VIDEO_MAX_BYTES = 64 * 1024 * 1024;

/** An MP4 carries an `ftyp` box at byte 4. */
export const isMp4 = (bytes: Uint8Array): boolean =>
  bytes.byteLength > 12 &&
  bytes[4] === 0x66 &&
  bytes[5] === 0x74 &&
  bytes[6] === 0x79 &&
  bytes[7] === 0x70;
