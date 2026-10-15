import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { create } from "xmlbuilder2";
import { embedProvenance } from "../src/provenance.js";
import {
  maximumPrintDownloadBytes,
  ProvenanceExportError,
  stripPrivateProvenance,
} from "../src/provenance-export.js";

const facts = {
  printId: "media_public_id",
  model: "model-private",
  prompt: "PRIVATE PROMPT",
  createdAt: 1_770_000_000_000,
};

describe("public export preserves pixels, never prompt or lineage", () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    it(`${format}: exports actual provider dimensions and leaves source unchanged`, async () => {
      const raw = await sharp({
        create: {
          width: 37,
          height: 29,
          channels: 4,
          background: { r: 34, g: 82, b: 109, alpha: 0.5 },
        },
      })
        .toFormat(format)
        .toBuffer();
      const embedded = await embedProvenance(raw, format, facts);
      expect(embedded.embedded).toBe(true);
      const original = embedded.bytes.slice();
      const output = await stripPrivateProvenance(embedded.bytes);
      expect(embedded.bytes).toEqual(original);
      expect(output.type).toBe(`image/${format}`);
      expect(
        await sharp(output.bytes).raw().toBuffer({ resolveWithObject: true }),
      ).toEqual(
        await sharp(original).raw().toBuffer({ resolveWithObject: true }),
      );
      const metadata = await sharp(output.bytes).metadata();
      const packet = new TextDecoder().decode(metadata.xmp);
      expect(packet).toContain(facts.printId);
      expect(packet).toContain("trainedAlgorithmicMedia");
      expect(packet).not.toContain(facts.prompt);
      expect(packet).not.toContain(facts.model);
      expect(create(packet).end()).not.toMatch(
        /prompt|model|derivedFrom|reference|CreateDate/,
      );
      expect(await stripPrivateProvenance(output.bytes)).toEqual(output);
    });
    it(`${format}: refuses truncated containers without returning their private bytes`, async () => {
      const raw = await sharp({
        create: { width: 37, height: 29, channels: 3, background: "red" },
      })
        .toFormat(format)
        .toBuffer();
      const embedded = await embedProvenance(raw, format, facts);
      await expect(
        stripPrivateProvenance(
          embedded.bytes.subarray(0, embedded.bytes.length - 12),
        ),
      ).rejects.toMatchObject({ reason: "invalid-image" });
    });
  }
  it("drops arbitrary private XMP and retains namespaced public attributes", async () => {
    const packet =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:f="https://fungi.computer/ns/provenance/1.0/" xmlns:i="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" f:printId="public-attribute" i:DigitalSourceType="trainedAlgorithmicMedia"><f:prompt>PRIVATE PROMPT</f:prompt><f:derivedFrom>PRIVATE PARENT</f:derivedFrom><f:references>PRIVATE PATH</f:references></rdf:Description></rdf:RDF></x:xmpmeta>';
    const raw = await sharp({
      create: { width: 12, height: 7, channels: 3, background: "blue" },
    })
      .withXmp(packet)
      .webp({ lossless: true })
      .toBuffer();
    const result = await stripPrivateProvenance(raw);
    const metadata = await sharp(result.bytes).metadata();
    const exported = new TextDecoder().decode(metadata.xmp);
    expect(exported).toContain("public-attribute");
    expect(exported).toContain("trainedAlgorithmicMedia");
    expect(exported).not.toContain("PRIVATE");
    expect(await sharp(result.bytes).raw().toBuffer()).toEqual(
      await sharp(raw).raw().toBuffer(),
    );
  });
  it("returns a typed too-large refusal before parsing", async () => {
    await expect(
      stripPrivateProvenance(new Uint8Array(maximumPrintDownloadBytes + 1)),
    ).rejects.toMatchObject({ reason: "too-large" });
  });
  it("refuses signed or malformed images instead of a raw-file fallback", async () => {
    await expect(
      stripPrivateProvenance(new TextEncoder().encode("c2pa")),
    ).rejects.toMatchObject({ reason: "signed-image" });
    await expect(
      stripPrivateProvenance(new Uint8Array([1, 2, 3])),
    ).rejects.toBeInstanceOf(ProvenanceExportError);
  });
});
