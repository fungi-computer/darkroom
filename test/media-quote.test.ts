import { describe, expect, it } from "vitest";
import {
  MediaSettingsError,
  validateMediaGenerationSettings,
} from "../src/index.js";
import { estimate } from "../src/cloudflare/provider.js";
import { mediaUnits } from "../src/gateway-models.js";
import { quoteMediaGeneration } from "../src/media-quote.js";

const noReferences = {
  read: () => Promise.reject(new Error("no reference expected")),
};
const png = (width: number, height: number) => ({
  bytes: new Uint8Array([1]),
  format: "png" as const,
  width,
  height,
});

describe("quoteMediaGeneration", () => {
  it("quotes a video as its admission estimate and billed seconds", async () => {
    const raw = {
      model: "bytedance/seedance-2.0",
      prompt: "fern fronds unfurling",
      width: 1280,
      height: 720,
      durationSeconds: 5,
      generateAudio: true,
    };
    const quote = await quoteMediaGeneration(raw, noReferences);
    const settings = validateMediaGenerationSettings(raw);
    expect(quote).toEqual({
      unit: "video_second",
      units: 5,
      providerCostMilliunits: estimate(settings, []),
    });
    expect(quote.providerCostMilliunits).toBeGreaterThan(0);
    const longer = await quoteMediaGeneration(
      { ...raw, durationSeconds: 10 },
      noReferences,
    );
    expect(longer.units).toBe(10);
    expect(longer.providerCostMilliunits).toBeGreaterThan(
      quote.providerCostMilliunits,
    );
  });

  it("reads references so their size counts, as admission does", async () => {
    const raw = {
      model: "openai/gpt-image-2",
      prompt: "a seed catalogue cover",
      width: 1024,
      height: 1024,
      references: [{ path: "/refs/a.png", computerId: "c" }],
    };
    const quote = await quoteMediaGeneration(raw, {
      read: () => Promise.resolve(png(1024, 1024)),
    });
    const settings = validateMediaGenerationSettings(raw);
    expect(quote).toEqual({
      ...mediaUnits(settings),
      providerCostMilliunits: estimate(settings, [{ ...png(1024, 1024) }]),
    });
    const bare = await quoteMediaGeneration(
      { ...raw, references: undefined },
      noReferences,
    );
    expect(quote.providerCostMilliunits).toBeGreaterThan(
      bare.providerCostMilliunits,
    );
  });

  it("refuses settings admission would refuse", async () => {
    await expect(
      quoteMediaGeneration(
        { model: "openai/gpt-image-2", prompt: "x", width: 7, height: 7 },
        noReferences,
      ),
    ).rejects.toBeInstanceOf(MediaSettingsError);
  });
});
