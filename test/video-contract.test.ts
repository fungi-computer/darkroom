import { describe, expect, it, vi } from "vitest";
import {
  validateMediaGenerationSettings,
  validateMediaVideoSelection,
  mediaVideoSelectionSchema,
  MediaSettingsError,
  getMediaModel,
  mediaVideoModelIdSchema,
  estimateVideoMilliunits,
} from "../src/index.js";
import {
  createMediaService,
  generateMedia,
  type MediaServiceHost,
} from "../src/server.js";
import { mediaOperationFixture } from "./fixtures/media-operation.fixture.js";
import { generate } from "../src/cloudflare/provider.js";
import {
  gatewayInput,
  estimateGatewayMilliunits,
  mediaUnits,
} from "../src/gateway-models.js";

const base = {
  model: "bytedance/seedance-2.0",
  prompt: "fern fronds unfurling",
  width: 1280,
  height: 720,
};
const image = (value: number) => ({
  bytes: new Uint8Array([value]),
  format: "png" as const,
  width: 1,
  height: 1,
});
const reference = (
  role: "first-frame" | "last-frame" | "reference",
  path: string = role,
) => ({ computerId: "pictures", path, role });

describe("verified video catalog contract", () => {
  it("retains every admitted frame and translates by role, independent of order", () => {
    const settings = validateMediaGenerationSettings({
      ...base,
      references: [reference("last-frame"), reference("first-frame")],
    });
    expect(gatewayInput(settings, [image(2), image(1)])).toMatchObject({
      image: "data:image/png;base64,AQ==",
      last_frame_image: "data:image/png;base64,Ag==",
    });
  });
  it("sends all four reference images using the provider reference mode", () => {
    const settings = validateMediaGenerationSettings({
      ...base,
      references: [0, 1, 2, 3].map((index) =>
        reference("reference", String(index)),
      ),
    });
    expect(
      gatewayInput(settings, [image(1), image(2), image(3), image(4)]),
    ).toMatchObject({
      reference_images: [
        "data:image/png;base64,AQ==",
        "data:image/png;base64,Ag==",
        "data:image/png;base64,Aw==",
        "data:image/png;base64,BA==",
      ],
    });
  });
  it("uses Veo's default audio price and string duration", () => {
    const settings = validateMediaGenerationSettings({
      ...base,
      model: "google/veo-3.1-fast",
    });
    expect(gatewayInput(settings)).toEqual({
      prompt: base.prompt,
      duration: "6s",
      resolution: "720p",
      aspect_ratio: "16:9",
      generate_audio: true,
    });
    expect(estimateGatewayMilliunits(settings)).toBe(60_000);
    expect(mediaUnits(settings)).toEqual({ unit: "video_second", units: 6 });
    expect(getMediaModel(settings.model)?.video?.defaultSeconds).toBe(6);
  });
  it("builds MiniMax H3 Max's documented content[] body and refuses an audio choice", () => {
    const minimax = getMediaModel("minimax/h3-max")?.video;
    if (!minimax) throw new Error("catalog missing minimax/h3-max");
    const defaultFormat = minimax.formats.find(
      (format) =>
        format.resolution === minimax.defaultResolution &&
        format.aspectRatio === minimax.defaultAspectRatio,
    );
    if (!defaultFormat) throw new Error("minimax default format missing");
    const settings = validateMediaGenerationSettings({
      model: "minimax/h3-max",
      prompt: "A golden retriever runs along a beach at sunrise",
      width: defaultFormat.width,
      height: defaultFormat.height,
      durationSeconds: 5,
    });
    expect(gatewayInput(settings)).toEqual({
      content: [
        {
          type: "text",
          text: "A golden retriever runs along a beach at sunrise",
        },
      ],
      duration: 5,
      resolution: "768P",
      ratio: "16:9",
    });
    expect(() => gatewayInput({ ...settings, generateAudio: true })).toThrow(
      "does not support an audio choice",
    );
  });
  it("sends a MiniMax first-frame image as a data-URI content[] item", () => {
    const settings = validateMediaGenerationSettings({
      model: "minimax/h3-max",
      prompt: "The camera slowly pans across the scene",
      width: 854,
      height: 480,
      references: [reference("first-frame")],
    });
    expect(gatewayInput(settings, [image(1)])).toEqual({
      content: [
        { type: "text", text: "The camera slowly pans across the scene" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AQ==" },
          role: "first_frame",
        },
      ],
      duration: 5,
      resolution: "480P",
      ratio: "16:9",
    });
  });
});

describe("video refinements and provider prices", () => {
  const select = (model = "bytedance/seedance-2.0", overrides = {}) =>
    validateMediaVideoSelection(
      mediaVideoSelectionSchema.parse({
        model,
        prompt: "fern fronds",
        ...overrides,
      }),
    );
  const hydrate = (selection: ReturnType<typeof select>) =>
    validateMediaGenerationSettings({
      ...selection,
      references: selection.references?.map((reference) => ({
        ...reference,
        computerId: "pictures",
      })),
    });
  it.each([
    ["bytedance/seedance-2.0", "480p", false, 7_000],
    ["bytedance/seedance-2.0", "720p", true, 15_000],
    ["bytedance/seedance-2.0", "1080p", false, 37_000],
    ["bytedance/seedance-2.0", "4k", true, 78_000],
    ["bytedance/seedance-2.0-fast", "480p", true, 6_000],
    ["bytedance/seedance-2.0-fast", "720p", false, 12_000],
    ["bytedance/seedance-2.0-mini", "480p", false, 4_000],
    ["bytedance/seedance-2.0-mini", "720p", true, 9_000],
    ["google/veo-3.1", "720p", false, 20_000],
    ["google/veo-3.1", "720p", true, 40_000],
    ["google/veo-3.1", "1080p", false, 20_000],
    ["google/veo-3.1", "1080p", true, 40_000],
    ["google/veo-3.1-fast", "720p", false, 8_000],
    ["google/veo-3.1-fast", "720p", true, 10_000],
    ["google/veo-3.1-fast", "1080p", false, 10_000],
    ["google/veo-3.1-fast", "1080p", true, 12_000],
  ])(
    "quotes %s/%s/audio=%s in provider milliunits per requested second",
    (model, resolution, generateAudio, perSecond) => {
      const settings = hydrate(
        select(model, { resolution, generateAudio, durationSeconds: 4 }),
      );
      expect(estimateVideoMilliunits(settings)).toBe(perSecond * 4);
      expect(
        estimateVideoMilliunits(
          select(model, { resolution, generateAudio, durationSeconds: 4 }),
        ),
      ).toBe(perSecond * 4);
      expect(estimateGatewayMilliunits(settings)).toBe(perSecond * 4);
      expect(mediaUnits(settings)).toEqual({ unit: "video_second", units: 4 });
    },
  );
  it.each([
    ["480p", false, 5_000],
    ["480p", true, 5_000],
    ["768p", false, 8_000],
    ["768p", true, 8_000],
  ])(
    "quotes minimax/h3-max/%s/audio=%s at the same rate; no documented audio surcharge",
    (resolution, generateAudio, perSecond) => {
      const settings = hydrate(
        select("minimax/h3-max", {
          resolution,
          generateAudio,
          durationSeconds: 5,
        }),
      );
      expect(estimateVideoMilliunits(settings)).toBe(perSecond * 5);
      expect(estimateGatewayMilliunits(settings)).toBe(perSecond * 5);
      expect(mediaUnits(settings)).toEqual({ unit: "video_second", units: 5 });
    },
  );
  it("admits every verified duration, aspect and resolution combination from the catalog", () => {
    for (const id of mediaVideoModelIdSchema.options) {
      const video = getMediaModel(id)?.video;
      expect(video).toBeDefined();
      if (!video) throw new Error("catalog video missing");
      for (const format of video.formats)
        for (const durationSeconds of video.durations)
          expect(
            select(id, {
              resolution: format.resolution,
              aspectRatio: format.aspectRatio,
              durationSeconds,
            }),
          ).toMatchObject({
            width: format.width,
            height: format.height,
            durationSeconds,
          });
    }
  });
  it.each([
    ["bytedance/seedance-2.0", { durationSeconds: 3 }],
    ["bytedance/seedance-2.0", { durationSeconds: 13 }],
    ["bytedance/seedance-2.0", { durationSeconds: 4.5 }],
    ["google/veo-3.1", { durationSeconds: 5 }],
    ["google/veo-3.1-fast", { resolution: "4k" }],
    ["google/veo-3.1", { resolution: "480p" }],
    ["google/veo-3.1", { aspectRatio: "4:3" }],
    ["bytedance/seedance-2.0-fast", { resolution: "1080p" }],
    [
      "bytedance/seedance-2.0",
      { references: [{ path: "last.png", role: "last-frame" }] },
    ],
    [
      "bytedance/seedance-2.0",
      {
        references: [
          { path: "first.png", role: "first-frame" },
          { path: "reference.png", role: "reference" },
        ],
      },
    ],
    [
      "bytedance/seedance-2.0",
      {
        references: [
          { path: "a.png", role: "first-frame" },
          { path: "b.png", role: "first-frame" },
        ],
      },
    ],
    [
      "bytedance/seedance-2.0",
      {
        resolution: "1080p",
        references: [{ path: "ref.png", role: "reference" }],
      },
    ],
    [
      "bytedance/seedance-2.0",
      {
        references: [0, 1, 2, 3, 4].map((index) => ({
          path: `${String(index)}.png`,
          role: "reference",
        })),
      },
    ],
    [
      "google/veo-3.1",
      {
        references: [
          { path: "a.png", role: "first-frame" },
          { path: "b.png", role: "last-frame" },
        ],
      },
    ],
    [
      "google/veo-3.1-fast",
      { references: [{ path: "ref.png", role: "reference" }] },
    ],
    ["bytedance/seedance-2.0", { prompt: "x".repeat(2001) }],
    ["bytedance/seedance-2.0", { referenceVideo: "video.mp4" }],
    [
      "bytedance/seedance-2.0",
      {
        references: [
          { path: "ref.png", role: "reference", computerId: "attacker" },
        ],
      },
    ],
    ["bytedance/seedance-2.0", { references: [{ path: "ref.png" }] }],
    [
      "bytedance/seedance-2.0",
      { references: [{ path: "ref.png", role: "video" }] },
    ],
    ["bytedance/seedance-2.5", {}],
    // MiniMax H3 Max: 5-15s, only 480p/768p, no 9:21, no audio choice.
    ["minimax/h3-max", { durationSeconds: 4 }],
    ["minimax/h3-max", { durationSeconds: 16 }],
    ["minimax/h3-max", { resolution: "1080p" }],
    ["minimax/h3-max", { aspectRatio: "9:21" }],
  ])("refuses unsupported %s selection %j", (model, overrides) => {
    expect(() => select(model, overrides)).toThrow();
  });
  it("returns the owner's typed refusal for unsupported combinations", () => {
    expect(() =>
      validateMediaVideoSelection({
        model: "google/veo-3.1",
        prompt: "x",
        durationSeconds: 5,
      }),
    ).toThrow(MediaSettingsError);
    expect(() =>
      validateMediaGenerationSettings({ ...base, resolution: "480p" }),
    ).toThrow(MediaSettingsError);
    expect(() => mediaUnits({ ...base, durationSeconds: 13 })).toThrow(
      MediaSettingsError,
    );
    expect(() =>
      mediaUnits({ ...base, model: "bytedance/seedance-2.5" }),
    ).toThrow(MediaSettingsError);
    expect(() =>
      estimateVideoMilliunits({
        ...base,
        model: "google/veo-3.1-fast",
        durationSeconds: 5,
      }),
    ).toThrow(MediaSettingsError);
    expect(() =>
      validateMediaGenerationSettings({
        ...base,
        model: "@cf/black-forest-labs/flux-1-schnell",
        generateAudio: true,
      }),
    ).toThrow(MediaSettingsError);
  });
  it("encodes a Veo first image as plain base64 and refuses lost resolved references", () => {
    const settings = hydrate(
      select("google/veo-3.1", {
        references: [{ path: "first.png", role: "first-frame" }],
      }),
    );
    expect(gatewayInput(settings, [image(1)])).toMatchObject({
      image_input: "AQ==",
      generate_audio: true,
    });
    expect(() => gatewayInput(settings, [])).toThrow(MediaSettingsError);
    expect(() => gatewayInput(hydrate(select()), [image(1)])).toThrow(
      MediaSettingsError,
    );
  });
  it("keeps the existing Workflow single-image input as first-frame mode", () => {
    const settings = validateMediaGenerationSettings({
      ...base,
      width: 720,
      height: 720,
      references: [{ computerId: "pictures", path: "panel.png" }],
    });
    expect(settings.references?.[0]?.role).toBe("first-frame");
    expect(gatewayInput(settings, [image(1)])).toMatchObject({
      image: "data:image/png;base64,AQ==",
      aspect_ratio: "1:1",
      duration: 5,
    });
  });
  it.each(mediaVideoModelIdSchema.options)(
    "fetches %s as bounded MP4 without the image decoder",
    async (model) => {
      const bytes = new Uint8Array([
        0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0,
      ]);
      // MiniMax answers with its documented task wrapper, not the Unified
      // gateway's {state, result} shape every other video model normalizes to.
      const run = vi.fn(() =>
        Promise.resolve(
          getMediaModel(model)?.video?.provider === "minimax"
            ? {
                task: {
                  id: "1",
                  model,
                  status: "succeeded",
                  created_at: 0,
                  updated_at: 0,
                  content: { url: "https://results.example/clip.mp4" },
                },
              }
            : {
                state: "Completed",
                result: { video: "https://results.example/clip.mp4" },
              },
        ),
      );
      const fetchResult = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(bytes)),
      );
      await expect(
        generate(
          { run },
          hydrate(select(model)),
          [],
          undefined,
          undefined,
          fetchResult,
        ),
      ).resolves.toEqual({ bytes, format: "mp4" });
      expect(run).toHaveBeenCalledOnce();
      expect(fetchResult).toHaveBeenCalledOnce();
    },
  );
  it("refuses a pending gateway answer before fetching output", async () => {
    const fetchResult = vi.fn<typeof fetch>();
    await expect(
      generate(
        {
          run: () =>
            Promise.resolve({
              state: "Running",
              result: { video: "https://results.example/clip.mp4" },
            }),
        },
        hydrate(select()),
        [],
        undefined,
        undefined,
        fetchResult,
      ),
    ).rejects.toMatchObject({ stage: "normalization" });
    expect(fetchResult).not.toHaveBeenCalled();
  });
  it("refuses video output without an explicit completion state", async () => {
    const fetchResult = vi.fn<typeof fetch>();
    await expect(
      generate(
        {
          run: () =>
            Promise.resolve({
              result: { video: "https://results.example/clip.mp4" },
            }),
        },
        hydrate(select()),
        [],
        undefined,
        undefined,
        fetchResult,
      ),
    ).rejects.toMatchObject({ stage: "normalization" });
    expect(fetchResult).not.toHaveBeenCalled();
  });
  it.each([
    { ...base, model: "google/veo-3.1", durationSeconds: 5 },
    { ...base, model: "@cf/black-forest-labs/flux-1-schnell", width: 5040 },
  ])(
    "refuses unsupported settings through the service before billing or provider dispatch: %j",
    async (invalidSettings) => {
      const fixture = mediaOperationFixture();
      try {
        const admit = vi.fn(() => Promise.resolve({ priceMilliunits: 60_000 }));
        const provider = vi.fn(() =>
          Promise.resolve({ bytes: new Uint8Array([1]), format: "mp4" }),
        );
        const beforeAdmit = vi.fn();
        const host = {
          scope: {
            actorId: "reader",
            namespace: "studio",
            owner: "prints",
            destinationId: "pictures",
          },
          operations: { getByName: () => fixture.owner },
          provider,
          beforeAdmit,
          metering: { admit, settle: () => Promise.resolve() },
          refusalMessages: {
            insufficient_credits: "refill",
            daily_limit_reached: "quota",
            denied: "denied",
          },
          destination: {
            authorize: () => Promise.resolve(),
            write: () => Promise.resolve(),
          },
        } satisfies MediaServiceHost;
        const service = createMediaService(host);
        await expect(
          generateMedia(host, {
            requestId: "invalid-video-promise",
            path: "prints-invalid-video.mp4",
            settings: invalidSettings,
          }),
        ).rejects.toBeInstanceOf(MediaSettingsError);
        const response = await service.request("/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": "invalid-video",
          },
          body: JSON.stringify({
            path: "prints-invalid-video.mp4",
            settings: invalidSettings,
          }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "INVALID_ARGUMENT",
          retryable: false,
        });
        expect(admit).not.toHaveBeenCalled();
        expect(provider).not.toHaveBeenCalled();
        expect(beforeAdmit).not.toHaveBeenCalled();
      } finally {
        fixture.close();
      }
    },
  );
});
