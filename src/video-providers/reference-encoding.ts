import type { MediaReferenceBytes } from "../index.js";

/** Encode in multiples of three so only the final chunk needs base64 padding. */
export function imageBase64(image: MediaReferenceBytes): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < image.bytes.length; offset += 32_766)
    chunks.push(
      btoa(
        String.fromCharCode(...image.bytes.subarray(offset, offset + 32_766)),
      ),
    );
  return chunks.join("");
}

export function imageDataUri(image: MediaReferenceBytes): string {
  const mime = image.format === "jpeg" ? "image/jpeg" : `image/${image.format}`;
  return `data:${mime};base64,${imageBase64(image)}`;
}
