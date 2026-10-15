import { Buffer as NodeBuffer } from "node:buffer";
import { replacePngXmp } from "./provenance-png.js";
import { replaceJpegXmp } from "./provenance-jpeg.js";
import webp from "node-webpmux";
import { create } from "xmlbuilder2";
import type { ImageFormat } from "./index.js";
import { reportCatchFailure } from "./failure.js";

/** Public file facts only; actor, namespace, billing and reference paths stay private. */
export type ProvenanceFacts = Readonly<{
  printId: string;
  model: string;
  prompt: string;
  createdAt: number;
}>;
export type ProvenanceEmbedResult =
  | Readonly<{ bytes: Uint8Array; embedded: true }>
  | Readonly<{
      bytes: Uint8Array;
      embedded: false;
      reason: "unsupported-format" | "signed-image" | "invalid-image";
    }>;

function packet(facts: ProvenanceFacts): string {
  const document = create({ invalidCharReplacement: "�" });
  const description = document
    .ele("adobe:ns:meta/", "x:xmpmeta")
    .ele("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf:RDF")
    .ele("rdf:Description")
    .att("rdf:about", "")
    .att("xmlns:xmp", "http://ns.adobe.com/xap/1.0/")
    .att("xmlns:Iptc4xmpExt", "http://iptc.org/std/Iptc4xmpExt/2008-02-29/")
    .att("xmlns:fungi", "https://fungi.computer/ns/provenance/1.0/");
  description
    .ele("xmp:CreateDate")
    .txt(new Date(facts.createdAt).toISOString());
  description
    .ele("Iptc4xmpExt:DigitalSourceType")
    .txt(
      "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
    );
  description.ele("fungi:printId").txt(facts.printId);
  description.ele("fungi:model").txt(facts.model);
  description.ele("fungi:prompt").txt(facts.prompt);
  return document.end({ headless: true });
}

async function embedWebp(bytes: Uint8Array, xmp: string): Promise<Uint8Array> {
  const image = new webp.Image();
  await image.load(NodeBuffer.from(bytes));
  image.xmp = NodeBuffer.from(xmp, "utf8");
  return image.save(null);
}

/** Deterministic enrichment. A failed embed never replaces or loses paid bytes.
 * Conservative C2PA detection preserves signed outputs unchanged rather than
 * claiming their old signatures still cover a modified file. */
export async function embedProvenance(
  bytes: Uint8Array,
  format: ImageFormat | "mp4",
  facts: ProvenanceFacts,
): Promise<ProvenanceEmbedResult> {
  if (format === "gif" || format === "mp4")
    return { bytes, embedded: false, reason: "unsupported-format" };
  if (
    NodeBuffer.from(bytes).includes("c2pa") ||
    NodeBuffer.from(bytes).includes("caBX")
  )
    return { bytes, embedded: false, reason: "signed-image" };
  try {
    const xmp = packet(facts);
    const output =
      format === "png"
        ? replacePngXmp(bytes, xmp)
        : format === "jpeg"
          ? replaceJpegXmp(bytes, xmp)
          : await embedWebp(bytes, xmp);
    return { bytes: output, embedded: true };
  } catch (cause) {
    reportCatchFailure("embed-provenance", cause);
    return { bytes, embedded: false, reason: "invalid-image" };
  }
}
