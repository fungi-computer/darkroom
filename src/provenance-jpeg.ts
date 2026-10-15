import { joinBytes, startsWithBytes } from "./provenance-bytes.js";
const jpegXmpSignature = "http://ns.adobe.com/xap/1.0/\0";
const jpegExtendedXmpSignature = "http://ns.adobe.com/xmp/extension/\0";

/** Narrow JPEG splice exception: adr-jpeg-provenance-splice. Never decode or
 * rewrite scan data; walk bounded header segments and preserve their bytes. */
export function replaceJpegXmp(bytes: Uint8Array, xmp: string): Uint8Array {
  const source = bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    source.length < 4 ||
    view.getUint16(0) !== 0xffd8 ||
    view.getUint16(source.length - 2) !== 0xffd9
  )
    throw new Error("Invalid JPEG envelope");
  const payload = new TextEncoder().encode(`${jpegXmpSignature}${xmp}`);
  if (payload.length > 65_533)
    throw new Error("XMP exceeds one JPEG APP1 segment");
  const header = new Uint8Array(4);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, 0xffe1);
  headerView.setUint16(2, payload.length + 2);
  const xmpSegment = joinBytes([header, payload]);
  const segments: Uint8Array[] = [source.subarray(0, 2)];
  let insertion = 1;
  let leading = true;
  let hasFrame = false;
  let offset = 2;
  while (offset + 4 <= source.length) {
    const start = offset;
    if (source[offset] !== 0xff) throw new Error("Invalid JPEG marker");
    while (source[offset] === 0xff) offset++;
    const marker = source[offset];
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 0xd8 ||
      marker === 0xd9
    )
      throw new Error("JPEG ended before its scan");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push(source.subarray(start, offset + 1));
      offset++;
      leading = false;
      continue;
    }
    if (offset + 3 > source.length) throw new Error("Truncated JPEG length");
    const length = view.getUint16(offset + 1);
    const end = offset + 1 + length;
    if (length < 2 || end > source.length)
      throw new Error("Truncated JPEG segment");
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      hasFrame = true;
    if (marker === 0xda) {
      if (!hasFrame) throw new Error("JPEG has no frame");
      segments.splice(insertion, 0, xmpSegment);
      segments.push(source.subarray(start));
      return joinBytes(segments);
    }
    const data = source.subarray(offset + 3, end);
    const isXmp =
      marker === 0xe1 &&
      [jpegXmpSignature, jpegExtendedXmpSignature].some((signature) =>
        startsWithBytes(data, signature),
      );
    if (!isXmp) {
      segments.push(source.subarray(start, end));
      if (
        leading &&
        (marker === 0xe0 ||
          (marker === 0xe1 && startsWithBytes(data, "Exif\0\0")))
      )
        insertion = segments.length;
      else leading = false;
    }
    offset = end;
  }
  throw new Error("JPEG has no scan");
}
