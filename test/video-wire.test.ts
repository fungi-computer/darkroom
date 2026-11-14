import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { listMediaModels } from "../src/index.js";
import {
  appMediaGenerationResultSchema,
  destinationSchema,
  mediaModelsSchema,
  appMediaGenerationOutcomeSchema,
  appMediaModelsOutcomeSchema,
  appMediaBrokerFailureSchema,
} from "../src/app-media-contracts.js";
import {
  mediaModelSchema,
  mediaVideoSelectionSchema,
  mediaVideoResultSchema,
  parseMediaGenerationInput,
} from "@fungi.computer/agar/media";
const decode = <A>(schema: Schema.Codec<A>, raw: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(raw);
describe("App broker media contract leaves", () => {
  it("keeps transformed failures and Agar polling separate from HTTP and transport envelopes", () => {
    const failure = {
      error: "HOST_FAILURE",
      message: "Media output could not be retained.",
      stage: "artifact",
      retryable: true,
    };
    expect(appMediaBrokerFailureSchema.parse(failure)).toEqual(failure);
    expect(appMediaGenerationOutcomeSchema.parse(failure)).toEqual(failure);
    const pending = { kind: "pending", retryAfterMs: 5000 };
    expect(appMediaGenerationOutcomeSchema.parse(pending)).toEqual(pending);
    expect(appMediaModelsOutcomeSchema.safeParse(pending).success).toBe(false);
    for (const payload of [
      {
        error: failure.message,
        code: failure.error,
        stage: failure.stage,
        retryable: failure.retryable,
      },
      { kind: "local_refusal", code: "denied" },
      { error: "unknown" },
      {
        error: "attachment_budget_exceeded",
        kind: "exec",
        retryAfterMs: 95_000,
      },
      { error: "attachment_budget_exceeded", kind: "media" },
      { status: "pending", retryAfterSeconds: 5 },
    ]) {
      expect(appMediaGenerationOutcomeSchema.safeParse(payload).success).toBe(
        false,
      );
    }
    expect(
      appMediaGenerationOutcomeSchema.parse({
        error: "library_unavailable",
        message: "",
      }),
    ).toEqual({ error: "library_unavailable", message: "" });
    expect(
      appMediaGenerationOutcomeSchema.safeParse({
        error: "library_unavailable",
        message: "x".repeat(4097),
      }).success,
    ).toBe(false);
    for (const error of ["invalid", "too_large"]) {
      expect(appMediaGenerationOutcomeSchema.parse({ error })).toEqual({
        error,
      });
    }
  });
  it("accepts the whole maintained catalog and bounds repeated entries", () => {
    const models = listMediaModels();
    expect(mediaModelsSchema.parse(models)).toEqual(models);
    expect(mediaModelsSchema.parse([])).toEqual([]);
    expect(mediaModelsSchema.safeParse([...models, ...models]).success).toBe(
      false,
    );
    expect(mediaModelsSchema.safeParse([{ id: "unknown" }]).success).toBe(
      false,
    );
  });

  it("preserves the admitted Computer and absolute destination bounds", () => {
    expect(
      destinationSchema.parse({ computerId: "computer", path: "/" }),
    ).toEqual({
      computerId: "computer",
      path: "/",
    });
    expect(
      destinationSchema.safeParse({ computerId: "", path: "/print.png" })
        .success,
    ).toBe(false);
    expect(
      destinationSchema.safeParse({ computerId: "c".repeat(257), path: "/" })
        .success,
    ).toBe(false);
    expect(
      destinationSchema.safeParse({ computerId: "computer", path: "print.png" })
        .success,
    ).toBe(false);
    expect(
      destinationSchema.safeParse({
        computerId: "computer",
        path: "/".repeat(1025),
      }).success,
    ).toBe(false);
  });

  it("decodes completed outputs without treating pending or host failures as results", () => {
    const result = {
      bytes: 1,
      costMilliunits: 0,
      format: "png",
      height: 1,
      model: "model",
      width: 1,
      destination: { computerId: "computer", path: "/print.png" },
    };
    expect(appMediaGenerationResultSchema.parse(result)).toEqual(result);
    expect(
      appMediaGenerationResultSchema.safeParse({
        ...result,
        path: "/print.png",
      }).success,
    ).toBe(false);
    expect(
      appMediaGenerationResultSchema.safeParse({ ...result, bytes: 0 }).success,
    ).toBe(false);
    expect(
      appMediaGenerationResultSchema.safeParse({
        kind: "pending",
        retryAfterMs: 5000,
      }).success,
    ).toBe(false);
    expect(
      appMediaGenerationResultSchema.safeParse({
        error: "HOST_FAILURE",
        message: "unavailable",
        stage: "artifact",
        retryable: true,
      }).success,
    ).toBe(false);
  });
});
describe("Agar-owned video wire and Darkroom host catalog", () => {
  it("decodes the actual host catalog, including every video price and role", () => {
    for (const model of listMediaModels())
      expect(decode(mediaModelSchema, model)).toEqual(model);
  });
  it("preserves video selectors and every reference role when normalizing an admitted selection", () => {
    const parsed = parseMediaGenerationInput({
      destination: { path: " prints-id.mp4 " },
      settings: {
        model: "bytedance/seedance-2.0",
        prompt: " fronds ",
        width: 5040,
        height: 2160,
        resolution: "4k",
        aspectRatio: "21:9",
        generateAudio: false,
        durationSeconds: 5,
        references: [
          { path: " first.png ", role: "first-frame" },
          { path: "last.png", role: "last-frame" },
        ],
      },
    });
    expect(
      parsed.settings.references?.map((reference) => reference.role),
    ).toEqual(["first-frame", "last-frame"]);
    expect(parsed.settings).toMatchObject({
      prompt: "fronds",
      resolution: "4k",
      aspectRatio: "21:9",
      generateAudio: false,
    });
    expect(parsed.destination.path).toBe("prints-id.mp4");
    expect(() =>
      parseMediaGenerationInput({
        destination: parsed.destination,
        settings: { ...parsed.settings, width: 5041 },
      }),
    ).toThrow();
  });
  it("refuses frame roles on the destination instead of silently discarding them", () => {
    const input = {
      destination: { path: "prints-id.mp4", role: "first-frame" },
      settings: {
        model: "host-model",
        prompt: "fronds",
        width: 720,
        height: 720,
      },
    };
    expect(() => parseMediaGenerationInput(input)).toThrow();
  });
  it("decodes the neutral path-only selection without accepting host authority", () => {
    const input = {
      model: "google/veo-3.1",
      prompt: "fronds",
      durationSeconds: 6,
      references: [{ path: "first.png", role: "first-frame" }],
    };
    expect(decode(mediaVideoSelectionSchema, input)).toEqual(input);
    expect(() =>
      decode(mediaVideoSelectionSchema, { ...input, computerId: "forged" }),
    ).toThrow();
  });
  it.each([
    { role: "last" },
    { durationSeconds: 3 },
    { durationSeconds: 16 },
    { durationSeconds: 4.5 },
    { references: [{ path: "first.png", role: "video" }] },
    { references: [{ path: "first.png" }] },
    { references: [{ path: "", role: "first-frame" }] },
    {
      references: Array.from({ length: 5 }, () => ({
        path: "ref.png",
        role: "reference",
      })),
    },
    { resolution: "8k" },
    { aspectRatio: "auto" },
  ])("refuses unsupported wire fields or bounds %j", (invalid) => {
    expect(() =>
      decode(mediaVideoSelectionSchema, {
        model: "host-model",
        prompt: "fronds",
        ...invalid,
      }),
    ).toThrow();
  });
  it("decodes a completed MP4 and refuses an image result in the video wire", () => {
    const result = {
      bytes: 12,
      costMilliunits: 60000,
      destination: { computerId: "admitted", path: "prints-id.mp4" },
      format: "mp4",
      height: 720,
      model: "google/veo-3.1-fast",
      width: 1280,
    };
    expect(decode(mediaVideoResultSchema, result)).toEqual(result);
    expect(() =>
      decode(mediaVideoResultSchema, { ...result, format: "png" }),
    ).toThrow();
  });
});
