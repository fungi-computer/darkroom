import type {
  MediaAudioReferenceBytes,
  MediaReferenceBytes,
} from "../index.js";

/** Encode in multiples of three so only the final chunk needs base64 padding. */
function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_766)
    chunks.push(
      btoa(String.fromCharCode(...bytes.subarray(offset, offset + 32_766))),
    );
  return chunks.join("");
}

export function imageBase64(image: MediaReferenceBytes): string {
  return base64(image.bytes);
}

/**
 * One `reference_audios` entry: a `data:audio/...` base64 URI, the form
 * Seedance 2.5's input schema documents next to HTTP(S) URLs.
 * https://developers.cloudflare.com/ai/models/bytedance/seedance-2.5/schema-input.json
 */
export function audioDataUri(clip: MediaAudioReferenceBytes): string {
  return `data:${clip.mimeType};base64,${base64(clip.bytes)}`;
}

export function imageDataUri(image: MediaReferenceBytes): string {
  const mime = image.format === "jpeg" ? "image/jpeg" : `image/${image.format}`;
  return `data:${mime};base64,${imageBase64(image)}`;
}
