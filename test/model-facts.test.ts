import { describe, expect, it } from "vitest";
import {
  listMediaModels,
  mediaModelSchema,
  parseMediaCatalogue,
  validateMediaGenerationSettings,
  type MediaModel,
} from "../src/index.js";
import { mediaBillingUnit } from "../src/model-catalog.js";
import { mediaModelsSchema } from "../src/app-media-contracts.js";
import { mediaUnits } from "../src/gateway-models.js";
import { createMediaService } from "../src/server.js";
import { mediaOperationFixture } from "./fixtures/media-operation.fixture.js";

/** Every fact an App needs to draw one model's controls, read from the entry alone. */
function facts(model: MediaModel) {
  const { video, audio } = model;
  return {
    kind: model.kind,
    durations:
      video !== null
        ? video.durations.length > 0
        : audio !== null
          ? audio.mode === "speech" || audio.seconds !== null
          : true,
    maxPromptLength: model.maxPromptLength,
    maxReferences: model.input.maxReferences,
    videoRoles: video?.referenceRoles ?? [],
    audioReferences: video === null ? null : video.audioReferences,
    sound: video === null ? null : video.supportsAudio,
    billingUnit: model.billingUnit,
  };
}

describe("model facts", () => {
  it("exposes the full set of facts for every catalog model", () => {
    const models = listMediaModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(mediaModelSchema.safeParse(model).success, model.id).toBe(true);
      const known = facts(model);
      expect(["image", "video", "audio"], model.id).toContain(known.kind);
      expect(known.durations, model.id).toBe(true);
      expect(known.maxPromptLength, model.id).toBeGreaterThan(0);
      expect(known.maxReferences, model.id).toBeGreaterThanOrEqual(0);
      if (model.kind === "video") {
        expect(model.video?.formats.length, model.id).toBeGreaterThan(0);
        expect(model.video?.referenceRoles, model.id).toBeDefined();
        expect([true, false], model.id).toContain(known.sound);
        expect(known.billingUnit, model.id).toBe("video_second");
      } else {
        expect(model.video, model.id).toBeNull();
      }
      if (model.kind === "audio")
        expect(known.billingUnit, model.id).toBe(
          model.audio?.mode === "speech"
            ? "audio_character_block"
            : "audio_second",
        );
      if (model.kind === "image") expect(known.billingUnit).toBe("image");
    }
  });

  it("bills in the unit the entry names", () => {
    for (const model of listMediaModels()) {
      expect(model.billingUnit).toBe(mediaBillingUnit(model));
      const settings =
        model.kind === "audio"
          ? { model: model.id, prompt: "x" }
          : model.transform !== null
            ? {
                model: model.id,
                prompt: "x",
                references: [{ computerId: "c", path: "/source.png" }],
              }
            : {
                model: model.id,
                prompt: "x",
                width: model.input.defaultWidth,
                height: model.input.defaultHeight,
              };
      expect(
        mediaUnits(validateMediaGenerationSettings(settings)).unit,
        model.id,
      ).toBe(model.billingUnit);
    }
  });

  it("refuses a host catalogue entry whose billingUnit disagrees with its kind", () => {
    const [image] = listMediaModels();
    expect(() =>
      parseMediaCatalogue([{ ...image, billingUnit: "video_second" }]),
    ).toThrow("billingUnit must be image for an image model");
    expect(parseMediaCatalogue([image])).toHaveLength(1);
  });

  it("serves billingUnit from /models", async () => {
    const fixture = mediaOperationFixture();
    try {
      const service = createMediaService({
        scope: {
          actorId: "a",
          namespace: "n",
          owner: "o",
          destinationId: "d",
        },
        operations: { getByName: () => fixture.owner },
        provider: () => Promise.reject(new Error("unused")),
        metering: "unmetered",
        destination: {
          authorize: () => Promise.resolve(),
          remove: () => Promise.resolve("absent" as const),
          write: () => Promise.resolve(),
        },
      });
      const listed = mediaModelsSchema.parse(
        await (await service.request("/models")).json(),
      );
      expect(listed.map(({ id, billingUnit }) => [id, billingUnit])).toEqual(
        listMediaModels().map(({ id, billingUnit }) => [id, billingUnit]),
      );
    } finally {
      fixture.close();
    }
  });
});
