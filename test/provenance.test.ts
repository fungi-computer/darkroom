import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { create } from "xmlbuilder2";
import extract from "png-chunks-extract";
import encode from "png-chunks-encode";
import { embedProvenance, type ProvenanceFacts } from "../src/provenance.js";

const facts: ProvenanceFacts = {
  printId: "media_op_abc123",
  model: "@cf/black-forest-labs/flux-2-klein-4b",
  prompt: "a fungus wearing a tiny hat & <raincoat>",
  createdAt: 1_770_000_000_000,
};
const forged =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:fungi="https://fungi.computer/ns/provenance/1.0/"><fungi:printId>FORGED</fungi:printId></rdf:Description></rdf:RDF></x:xmpmeta>';
const formats = ["png", "jpeg", "webp"] as const;
async function image(
  format: (typeof formats)[number],
  options: { lossless?: boolean; alpha?: boolean; xmp?: boolean } = {},
) {
  let pipeline = sharp({
    create: {
      width: 64,
      height: 48,
      channels: options.alpha ? 4 : 3,
      background: { r: 40, g: 90, b: 140, alpha: 0.4 },
    },
  });
  if (options.xmp) pipeline = pipeline.withXmp(forged);
  return pipeline
    .toFormat(format, { lossless: options.lossless ?? false })
    .toBuffer();
}
async function verify(original: Uint8Array, output: Uint8Array) {
  const before = await sharp(original)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const after = await sharp(output).raw().toBuffer({ resolveWithObject: true });
  expect(after).toEqual(before);
  const metadata = await sharp(output).metadata();
  expect(metadata.width).toBe(64);
  expect(metadata.height).toBe(48);
  const packet = metadata.xmp
    ? new TextDecoder().decode(metadata.xmp)
    : undefined;
  expect(packet).toBeDefined();
  if (!packet) throw new Error("Missing XMP");
  const document = create(packet);
  const values = document.node.ownerDocument ?? document.node;
  expect(values.textContent).toBeDefined();
  expect(packet).toContain("media_op_abc123");
  expect(packet).toContain("trainedAlgorithmicMedia");
  expect(packet).not.toContain("FORGED");
  expect(packet).not.toMatch(/actorUserId|costMilliunits/);
  return packet;
}
describe("provenance preserves real provider images", () => {
  for (const format of formats) {
    it(`${format}: replaces provider XMP, preserves decoded pixels and is deterministic`, async () => {
      const original = await image(format, { xmp: true });
      const result = await embedProvenance(original, format, facts);
      expect(result.embedded).toBe(true);
      await verify(original, result.bytes);
      expect(await embedProvenance(original, format, facts)).toEqual(result);
      expect(
        (await embedProvenance(result.bytes, format, facts)).bytes,
      ).toEqual(result.bytes);
    });
  }
  for (const lossless of [false, true]) {
    it(`WebP ${lossless ? "VP8L alpha" : "VP8"}: dimensions come from pixels, not request`, async () => {
      const original = await image("webp", { lossless, alpha: lossless });
      const result = await embedProvenance(original, "webp", facts);
      expect(result.embedded).toBe(true);
      await verify(original, result.bytes);
    });
  }
  it("keeps Exif before the replacement JPEG packet and refuses truncated headers", async () => {
    const original = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#285a8c" },
    })
      .withExif({ IFD0: { Artist: "fixture" } })
      .jpeg()
      .toBuffer();
    const result = await embedProvenance(original, "jpeg", facts);
    expect(result.embedded).toBe(true);
    await verify(original, result.bytes);
    const text = new TextDecoder().decode(result.bytes);
    expect(text.indexOf("Exif")).toBeLessThan(
      text.indexOf("http://ns.adobe.com/xap/1.0/"),
    );
    for (const length of [2, 5, 16, original.length - 1]) {
      const truncated = original.subarray(0, length);
      expect(await embedProvenance(truncated, "jpeg", facts)).toMatchObject({
        embedded: false,
        bytes: truncated,
      });
    }
  });
  it("replaces legacy PNG text XMP rather than leaving a contradictory packet", async () => {
    const chunks = extract(await image("png"));
    chunks.splice(1, 0, {
      name: "tEXt",
      data: new TextEncoder().encode(`XML:com.adobe.xmp\0${forged}`),
    });
    const original = encode(chunks);
    const result = await embedProvenance(original, "png", facts);
    await verify(original, result.bytes);
    expect(
      extract(result.bytes).filter((chunk) =>
        ["iTXt", "tEXt"].includes(chunk.name),
      ),
    ).toHaveLength(1);
  });
  it("replaces XML-illegal prompt characters while keeping Unicode and escapes", async () => {
    const original = await image("png");
    const result = await embedProvenance(original, "png", {
      ...facts,
      prompt: "hi\u0001 & <moon> 🍄",
    });
    const packet = await verify(original, result.bytes);
    expect(packet.includes(String.fromCharCode(1))).toBe(false);
    expect(packet).toContain("🍄");
    expect(packet).toContain("&amp;");
  });
  it("preserves provider C2PA containers without invalidating signatures", async () => {
    const chunks = extract(await image("png"));
    chunks.splice(1, 0, {
      name: "caBX",
      data: new TextEncoder().encode("c2pa proof manifest"),
    });
    const signed = encode(chunks);
    const result = await embedProvenance(signed, "png", facts);
    expect(result).toMatchObject({ embedded: false, reason: "signed-image" });
    expect(result.bytes).toEqual(signed);
  });
  it("refuses malformed and mismatched containers without losing their bytes", async () => {
    for (const format of formats) {
      const invalid = new Uint8Array([1, 2, 3]);
      const result = await embedProvenance(invalid, format, facts);
      expect(result).toMatchObject({ embedded: false });
      expect(result.bytes).toEqual(invalid);
    }
    const png = await image("png");
    expect(await embedProvenance(png, "jpeg", facts)).toMatchObject({
      embedded: false,
      bytes: png,
    });
  });
  it("leaves unsupported GIF/video bytes intact with an explicit disposition", async () => {
    for (const format of ["gif", "mp4"] as const) {
      const original = new Uint8Array([1, 2, 3]);
      expect(await embedProvenance(original, format, facts)).toMatchObject({
        embedded: false,
        reason: "unsupported-format",
        bytes: original,
      });
    }
  });
});
