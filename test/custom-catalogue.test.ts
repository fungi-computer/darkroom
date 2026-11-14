import { describe, expect, it, vi } from "vitest";
import {
  MediaSettingsError,
  parseMediaCatalogue,
  validateMediaGenerationSettings,
  validateMediaVideoSelection,
  estimateVideoMilliunits,
  type MediaCatalogue,
} from "../src/index.js";
import {
  createMediaService,
  generateMedia,
  type MediaServiceHost,
} from "../src/server.js";
import { mediaOperationFixture } from "./fixtures/media-operation.fixture.js";

const imageEntry = {
  id: "fal-ai/flux/dev",
  label: "FLUX dev (fal.ai)",
  kind: "image",
  tier: "balanced",
  outputFormats: ["png"],
  maxPromptLength: 500,
  input: {
    transport: "json",
    dimensions: "own",
    maxDimension: 1024,
    maxDimensionDocumented: true,
    defaultWidth: 512,
    defaultHeight: 512,
    steps: "steps",
    maxSteps: 12,
    defaultSteps: 6,
    referenceField: null,
    maxReferences: 0,
    referenceDimension: null,
    referenceFormat: "png",
  },
  sizes: null,
  video: null,
};
const videoEntry = {
  id: "fal-ai/minimax/hailuo-2.3/standard/image-to-video",
  label: "Hailuo 2.3 Standard (fal.ai)",
  kind: "video",
  tier: "draft",
  outputFormats: [],
  maxPromptLength: 2_000,
  input: {
    ...imageEntry.input,
    maxDimension: 1920,
    steps: "fixed",
    maxSteps: null,
    defaultSteps: null,
    referenceField: "image_url",
    maxReferences: 1,
  },
  sizes: ["1366x768"],
  video: {
    minSeconds: 6,
    maxSeconds: 10,
    defaultSeconds: 6,
    durations: [6, 10],
    provider: "host",
    formats: [
      {
        resolution: "768p",
        aspectRatio: "16:9",
        width: 1366,
        height: 768,
      },
    ],
    defaultResolution: "768p",
    defaultAspectRatio: "16:9",
    supportsAudio: false,
    defaultGenerateAudio: null,
    referenceRoles: ["first-frame"],
    maxReferenceImages: 0,
    referenceResolutions: [],
    prices: [
      {
        resolution: "768p",
        silentMilliunitsPerSecond: 3_000,
        audioMilliunitsPerSecond: 3_000,
      },
    ],
  },
};
const catalogue: MediaCatalogue = parseMediaCatalogue([imageEntry, videoEntry]);
const gatewayModel = "bytedance/seedance-2.0";
const customImage = {
  model: imageEntry.id,
  prompt: "a quiet greenhouse",
  width: 512,
  height: 512,
};

describe("provider-owned model catalogue", () => {
  it("accepts a custom provider's model id and applies its defaults", () => {
    expect(
      validateMediaGenerationSettings(customImage, catalogue),
    ).toMatchObject({ model: imageEntry.id, steps: 6 });
    expect(
      validateMediaVideoSelection(
        { model: videoEntry.id, prompt: "x" },
        catalogue,
      ),
    ).toMatchObject({
      model: videoEntry.id,
      width: 1366,
      durationSeconds: 6,
      resolution: "768p",
    });
    expect(
      estimateVideoMilliunits(
        validateMediaVideoSelection(
          { model: videoEntry.id, prompt: "x", durationSeconds: 10 },
          catalogue,
        ),
        catalogue,
      ),
    ).toBe(30_000);
  });

  it("refuses that model under the built-in provider, and the built-in model under the custom one", () => {
    expect(() => validateMediaGenerationSettings(customImage)).toThrow(
      MediaSettingsError,
    );
    expect(() =>
      validateMediaVideoSelection({ model: videoEntry.id, prompt: "x" }),
    ).toThrow(MediaSettingsError);
    expect(() =>
      validateMediaGenerationSettings(
        { model: gatewayModel, prompt: "x", width: 1280, height: 720 },
        catalogue,
      ),
    ).toThrow(MediaSettingsError);
  });

  it("refuses settings outside the custom bounds", () => {
    const refuse = (
      settings: Partial<typeof customImage & { steps: number }>,
    ) => {
      expect(() =>
        validateMediaGenerationSettings(
          { ...customImage, ...settings },
          catalogue,
        ),
      ).toThrow(MediaSettingsError);
    };
    refuse({ steps: 13 });
    refuse({ width: 2048 });
    refuse({ prompt: "x".repeat(501) });
    expect(() =>
      validateMediaVideoSelection(
        { model: videoEntry.id, prompt: "x", durationSeconds: 8 },
        catalogue,
      ),
    ).toThrow(MediaSettingsError);
  });

  it("refuses catalogues that contradict themselves", () => {
    expect(() => parseMediaCatalogue([])).toThrow(MediaSettingsError);
    expect(() => parseMediaCatalogue([imageEntry, imageEntry])).toThrow(
      /duplicate/u,
    );
    expect(() =>
      parseMediaCatalogue([{ ...imageEntry, kind: "video" }]),
    ).toThrow(/video bounds/u);
    expect(() =>
      parseMediaCatalogue([
        { ...videoEntry, video: { ...videoEntry.video, defaultSeconds: 8 } },
      ]),
    ).toThrow(/durations/u);
  });

  it("generates through the durable operation with a fake provider and its catalogue", async () => {
    const fixture = mediaOperationFixture(
      ":memory:",
      new Map(),
      undefined,
      "media-operation-custom",
      { catalogue: () => catalogue },
    );
    try {
      const provider = vi.fn(() =>
        Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), format: "png" }),
      );
      const write = vi.fn(() => Promise.resolve());
      const host = {
        scope: {
          actorId: "reader",
          namespace: "studio",
          owner: "composer",
          destinationId: "pictures",
        },
        operations: { getByName: () => fixture.owner },
        provider,
        catalogue,
        estimate: () => 1_000,
        metering: "unmetered",
        destination: { authorize: () => Promise.resolve(), write },
      } satisfies MediaServiceHost;
      const models = await createMediaService(host).request("/models");
      expect(
        (await models.json<{ id: string }[]>()).map(({ id }) => id),
      ).toEqual([imageEntry.id, videoEntry.id]);
      await expect(
        generateMedia(host, {
          requestId: "custom-model",
          path: "fern.png",
          settings: customImage,
        }),
      ).resolves.toMatchObject({
        kind: "succeeded",
        model: imageEntry.id,
        costMilliunits: 1_000,
      });
      expect(provider).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      await expect(
        generateMedia(host, {
          requestId: "gateway-model",
          path: "clip.mp4",
          settings: {
            model: gatewayModel,
            prompt: "x",
            width: 1280,
            height: 720,
          },
        }),
      ).rejects.toBeInstanceOf(MediaSettingsError);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      fixture.close();
    }
  });
});
