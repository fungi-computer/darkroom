import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { validateMediaGenerationSettings } from "../src/index.js";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";

const lucid = "@cf/leonardo/lucid-origin";
const phoenix = "@cf/leonardo/phoenix-1.0";
const flux = "@cf/black-forest-labs/flux-1-schnell";

const png = async () =>
  new Uint8Array(
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: "white" },
    })
      .png()
      .toBuffer(),
  );

/** Run one generation against a recording Workers AI binding; no network. */
const sentBody = async (input: {
  model: string;
  guidance?: number;
}): Promise<object> => {
  const image = await png();
  const run = vi.fn<MediaAiPort["run"]>().mockResolvedValue(image);
  const settings = validateMediaGenerationSettings({
    prompt: "a lantern",
    width: 1024,
    height: 1024,
    ...input,
  });
  await generate({ run }, settings, []);
  expect(run).toHaveBeenCalledTimes(1);
  const body = run.mock.calls[0]?.[1];
  if (body === undefined) throw new Error("the binding was not called");
  return body;
};

describe("Workers AI image guidance in the request body", () => {
  it("sends an explicit guidance to Lucid Origin", async () => {
    expect(await sentBody({ model: lucid, guidance: 7 })).toMatchObject({
      guidance: 7,
    });
  });

  it("sends the catalog default guidance when none is given", async () => {
    expect(await sentBody({ model: lucid })).toMatchObject({ guidance: 5 });
    expect(await sentBody({ model: phoenix })).toMatchObject({ guidance: 3 });
  });

  it("sends no guidance key to a model that takes none", async () => {
    expect(await sentBody({ model: flux })).not.toHaveProperty("guidance");
  });

  it("refuses guidance outside the model's range, naming the range", () => {
    expect(() =>
      validateMediaGenerationSettings({
        model: lucid,
        prompt: "a lantern",
        width: 1024,
        height: 1024,
        guidance: 11,
      }),
    ).toThrow(`${lucid} accepts guidance from 0 through 10`);
    expect(() =>
      validateMediaGenerationSettings({
        model: phoenix,
        prompt: "a lantern",
        width: 1024,
        height: 1024,
        guidance: 1,
      }),
    ).toThrow(`${phoenix} accepts guidance from 2 through 10`);
  });

  it("refuses guidance on a model without a guidance range", () => {
    expect(() =>
      validateMediaGenerationSettings({
        model: flux,
        prompt: "a lantern",
        width: 1024,
        height: 1024,
        guidance: 5,
      }),
    ).toThrow(`${flux} does not take guidance`);
  });
});
