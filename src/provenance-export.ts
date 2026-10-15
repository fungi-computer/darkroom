import { DOMParser } from "@xmldom/xmldom";
import ExifReader from "exifreader";
import { createRiffContainer, parseRiff } from "@fungi.computer/ts-webp";
import { replacePngXmp } from "./provenance-png.js";
import { replaceJpegXmp } from "./provenance-jpeg.js";
import { publicProvenancePacket } from "./provenance-xmp.js";

/** The admitted Computer file read and generated output share this launch bound. */
export const maximumPrintDownloadBytes = 32 * 1024 * 1024;
/** Why a lossless public image export was refused. */
export type ProvenanceExportFailure =
  "too-large" | "signed-image" | "invalid-image" | "unsupported-format";
/** A refusal to export unsafe, unsupported or oversized image bytes. */
export class ProvenanceExportError extends Error {
  /** Stable export refusal name. */
  override readonly name = "ProvenanceExportError";
  constructor(
    /** Bounded refusal reason. */
    readonly reason: ProvenanceExportFailure,
    options?: ErrorOptions,
  ) {
    super(`Print export refused: ${reason}`, options);
  }
}

function replaceWebpXmp(bytes: Uint8Array, xmp: string): Uint8Array {
  const chunks = parseRiff(bytes);
  // The maintained parser tolerates truncation for inspection. Export must not
  // turn a partial file into an apparently successful download.
  if (
    chunks.some((chunk) => chunk.size !== chunk.data.length) ||
    chunks.reduce(
      (length, chunk) => length + 8 + chunk.size + (chunk.size % 2),
      12,
    ) !== bytes.length
  )
    throw new Error("Incomplete extended WebP");
  if (!chunks.some((chunk) => chunk.fourCC === "XMP ")) return bytes;
  if (!chunks.some((chunk) => chunk.fourCC === "VP8X"))
    throw new Error("XMP without extended WebP header");
  let inserted = false;
  return createRiffContainer(
    chunks.flatMap((chunk) => {
      if (chunk.fourCC !== "XMP ")
        return [
          {
            fourCC: chunk.fourCC,
            data: chunk.data,
          },
        ];
      if (inserted) return [];
      inserted = true;
      return [
        {
          fourCC: "XMP ",
          data: new TextEncoder().encode(xmp),
        },
      ];
    }),
  );
}

/** Lossless browser export. Never mutates the input or falls back to private bytes. */
export async function stripPrivateProvenance(bytes: Uint8Array): Promise<{
  /** Image bytes with private provenance removed. */
  bytes: Uint8Array;
  /** Actual output MIME type. */
  type: string;
  /** Filename extension matching the output encoding. */
  extension: string;
}> {
  if (bytes.length > maximumPrintDownloadBytes)
    throw new ProvenanceExportError("too-large");
  // Match the embed owner's conservative signed-image policy. This is not
  // signature validation, and stripping never silently invalidates a signature.
  const text = new TextDecoder("latin1").decode(bytes);
  if (text.includes("c2pa") || text.includes("caBX"))
    throw new ProvenanceExportError("signed-image");
  try {
    const metadata = await ExifReader.loadView(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      {
        expanded: true,
        async: true,
        domParser: new DOMParser(),
        includeTags: { xmp: true, png: true, file: true },
        decompress: { maxDecompressedSize: maximumPrintDownloadBytes },
      },
    );
    const format = metadata.file?.FileType?.value;
    if (
      format !== "png" &&
      format !== "jpeg" &&
      format !== "webp" &&
      format !== "gif"
    )
      throw new ProvenanceExportError("unsupported-format");
    const mime = {
      type: `image/${format}`,
      extension: format === "jpeg" ? "jpg" : format,
    };
    if (format === "gif" && !metadata.xmp) return { bytes, ...mime };
    const packet = publicProvenancePacket(
      metadata.xmp?._raw ?? metadata.pngText?.["XML:com.adobe.xmp"]?.value,
    );
    const output =
      format === "png"
        ? replacePngXmp(bytes, packet)
        : format === "jpeg"
          ? replaceJpegXmp(bytes, packet)
          : format === "webp"
            ? replaceWebpXmp(bytes, packet)
            : undefined;
    if (!output) throw new ProvenanceExportError("unsupported-format");
    if (output.length > maximumPrintDownloadBytes)
      throw new ProvenanceExportError("too-large");
    return {
      bytes: output,
      ...mime,
    };
  } catch (cause) {
    if (cause instanceof ProvenanceExportError) throw cause;
    throw new ProvenanceExportError("invalid-image", { cause });
  }
}
