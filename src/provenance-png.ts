import extractPng from "png-chunks-extract";
import encodePng from "png-chunks-encode";
import { joinBytes, startsWithBytes } from "./provenance-bytes.js";

export function replacePngXmp(bytes: Uint8Array, xmp: string): Uint8Array {
  const chunks = extractPng(bytes);
  const keyword = "XML:com.adobe.xmp\0";
  const kept = chunks.filter(
    (chunk) =>
      !(
        ["iTXt", "tEXt", "zTXt"].includes(chunk.name) &&
        startsWithBytes(chunk.data, keyword)
      ),
  );
  const imageIndex = kept.findIndex((chunk) => chunk.name === "IDAT");
  if (imageIndex < 0) throw new Error("PNG has no image data");
  kept.splice(imageIndex, 0, {
    name: "iTXt",
    data: joinBytes([
      new TextEncoder().encode(keyword),
      new Uint8Array(4),
      new TextEncoder().encode(xmp),
    ]),
  });
  return encodePng(kept);
}
