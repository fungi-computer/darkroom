import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import {
  getMediaModel,
  listMediaModels,
  validateMediaGenerationSettings,
} from "../src/index.js";
import {
  estimateGatewayMilliunits,
  gatewayInput,
  mediaUnits,
} from "../src/gateway-models.js";
import { generate } from "../src/cloudflare/provider.js";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
]);
/** The first bytes of an MP4: a 24-byte `ftyp` box. */
const mp4 = Uint8Array.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
  0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
]);

const image = (size = "1024x1536") => {
  const [width, height] = size.split("x").map(Number);
  return validateMediaGenerationSettings({
    model: "openai/gpt-image-2",
    prompt: "a seed catalogue cover",
    width: width ?? 0,
    height: height ?? 0,
  });
};
const video = (durationSeconds?: number, size = "1280x720") => {
  const [width, height] = size.split("x").map(Number);
  const settings: Parameters<typeof validateMediaGenerationSettings>[0] = {
    model: "bytedance/seedance-2.0",
    prompt: "fern fronds unfurling",
    width: width ?? 0,
    height: height ?? 0,
  };
  if (durationSeconds !== undefined) settings.durationSeconds = durationSeconds;
  return validateMediaGenerationSettings(settings);
};
const minimaxVideo = (durationSeconds?: number, size = "1366x768") => {
  const [width, height] = size.split("x").map(Number);
  const settings: Parameters<typeof validateMediaGenerationSettings>[0] = {
    model: "minimax/h3-max",
    prompt: "fern fronds unfurling",
    width: width ?? 0,
    height: height ?? 0,
  };
  if (durationSeconds !== undefined) settings.durationSeconds = durationSeconds;
  return validateMediaGenerationSettings(settings);
};

describe("gateway Media models", () => {
  it("accepts only each model's provider sizes and video bounds", () => {
    expect(() => image("1024x768")).toThrow("accepts only these sizes");
    expect(() => video(5, "1000x720")).toThrow("accepts only these sizes");
    expect(video().durationSeconds).toBe(5);
    expect(() => video(3)).toThrow("durationSeconds");
    expect(() => video(13)).toThrow("durationSeconds");
    expect(() =>
      validateMediaGenerationSettings({
        model: "openai/gpt-image-2",
        prompt: "x",
        width: 1024,
        height: 1024,
        durationSeconds: 5,
      }),
    ).toThrow("does not take a duration");
  });

  it("bills images as one unit and video per requested second", () => {
    expect(mediaUnits(image())).toEqual({ unit: "image", units: 1 });
    expect(mediaUnits(video(8))).toEqual({ unit: "video_second", units: 8 });
  });

  it("quotes published gateway rates in milliunits", () => {
    // 1,584 output tokens at $30/M + 22 prompt characters bounded at $5/M.
    expect(estimateGatewayMilliunits(image(), [])).toBe(
      Math.ceil((1584 * 30 + 22 * 5) / 10),
    );
    // Seedance 2.0 at 720p is $0.15/s; 480p is $0.07/s.
    expect(estimateGatewayMilliunits(video(5), [])).toBe(75_000);
    expect(estimateGatewayMilliunits(video(4, "854x480"), [])).toBe(28_000);
  });

  it("passes each pinned image format to the gateway provider", () => {
    for (const format of ["png", "jpeg", "webp"] as const)
      expect(gatewayInput(image(), [], format)).toMatchObject({
        output_format: format,
      });
  });

  it("builds each provider body from its documented schema", () => {
    expect(gatewayInput(image())).toEqual({
      prompt: "a seed catalogue cover",
      size: "1024x1536",
      quality: "medium",
      output_format: "png",
    });
    expect(gatewayInput(video(6, "720x1280"))).toEqual({
      prompt: "fern fronds unfurling",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "9:16",
      // Seedance sound defaults On (Botanical's choice; the provider has none).
      generate_audio: true,
    });
    expect(
      gatewayInput(
        {
          ...video(5, "720x720"),
          references: [
            { computerId: "pictures", path: "panel.png", role: "first-frame" },
          ],
        },
        [
          {
            bytes: png,
            format: "png",
            width: 1,
            height: 1,
          },
        ],
      ),
    ).toMatchObject({
      image: `data:image/png;base64,${btoa(String.fromCharCode(...png))}`,
    });
  });

  it("encodes a full panel reference across bounded base64 chunks", () => {
    const bytes = new Uint8Array(114_619).map((_, index) => index % 251);
    const input = gatewayInput(
      {
        ...video(5, "720x720"),
        references: [
          { computerId: "pictures", path: "panel.png", role: "first-frame" },
        ],
      },
      [{ bytes, format: "png", width: 1024, height: 1024 }],
    );
    const { image } = z.object({ image: z.string() }).parse(input);
    const encoded = image.split(",")[1];
    expect(encoded).toBeDefined();
    expect(
      Uint8Array.from(atob(encoded ?? ""), (char) => char.charCodeAt(0)),
    ).toEqual(bytes);
  });

  // Replayed provider fixtures: the documented gateway answer shape
  // (`{ state, result: { image | video } }`), since no live key runs here.
  it.each([
    ["image", image(), "image", png, "png"],
    ["video", video(5), "video", mp4, "mp4"],
  ] as const)(
    "fetches the %s result URL through the gateway route",
    async (_label, settings, field, bytes, format) => {
      const run = vi.fn(() =>
        Promise.resolve({
          state: "Completed",
          result: { [field]: `https://results.example/${field}` },
        }),
      );
      const fetchResult = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(bytes)),
      );

      const ai = { run };
      await expect(
        generate(
          ai,
          settings,
          [],
          undefined,
          { gateway: { id: "fungi-hub" } },
          fetchResult,
        ),
      ).resolves.toMatchObject({ format });
      expect(run).toHaveBeenCalledWith(settings.model, gatewayInput(settings), {
        gateway: { id: "fungi-hub" },
      });
      expect(fetchResult.mock.calls[0]?.[0]).toBe(
        `https://results.example/${field}`,
      );
    },
  );

  // MiniMax answers with its documented `{task: {status, content: {url}}}`
  // wrapper, not the Unified gateway's `{state, result}` shape.
  it("dispatches MiniMax H3 Max's exact documented request and decodes its task wrapper", async () => {
    const settings = minimaxVideo(5);
    const run = vi.fn(() =>
      Promise.resolve({
        task: {
          id: "441805798383681",
          model: "MiniMax-H3-Max",
          status: "succeeded",
          created_at: 1_789_415_547,
          updated_at: 1_789_415_554,
          content: {
            url: "https://examples.aig.cloudflare.com/minimax/h3-max/clip.mp4",
          },
          resolution: "768P",
          duration: 5,
          ratio: "16:9",
          task_type: "generation",
        },
      }),
    );
    const fetchResult = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(mp4)),
    );
    const ai = { run };
    await expect(
      generate(ai, settings, [], undefined, undefined, fetchResult),
    ).resolves.toEqual({ bytes: mp4, format: "mp4" });
    expect(run).toHaveBeenCalledWith(
      settings.model,
      {
        content: [{ type: "text", text: "fern fronds unfurling" }],
        duration: 5,
        resolution: "768P",
        ratio: "16:9",
      },
      undefined,
    );
    expect(fetchResult.mock.calls[0]?.[0]).toBe(
      "https://examples.aig.cloudflare.com/minimax/h3-max/clip.mp4",
    );
  });

  it.each(["queued", "running", "failed", "cancelled"] as const)(
    "refuses a MiniMax task that has not succeeded (%s)",
    async (status) => {
      const run = () => Promise.resolve({ task: { id: "1", status } });
      await expect(
        generate({ run }, minimaxVideo(5), []),
      ).rejects.toMatchObject({ stage: "normalization" });
    },
  );

  it("refuses a non-HTTPS or non-MP4 MiniMax result", async () => {
    const plain = {
      run: () =>
        Promise.resolve({
          task: { id: "1", status: "succeeded", content: { url: "http://x" } },
        }),
    };
    await expect(generate(plain, minimaxVideo(5), [])).rejects.toMatchObject({
      stage: "normalization",
    });
    const notMp4 = {
      run: () =>
        Promise.resolve({
          task: {
            id: "1",
            status: "succeeded",
            content: { url: "https://x.example/v" },
          },
        }),
    };
    await expect(
      generate(notMp4, minimaxVideo(5), [], undefined, undefined, () =>
        Promise.resolve(new Response(png)),
      ),
    ).rejects.toMatchObject({ stage: "normalization" });
  });

  it("refuses a non-HTTPS or non-MP4 result", async () => {
    const plain = {
      run: () => Promise.resolve({ result: { video: "http://x.example/v" } }),
    };

    await expect(generate(plain, video(5), [])).rejects.toMatchObject({
      stage: "normalization",
    });
    const notMp4 = {
      run: () => Promise.resolve({ result: { video: "https://x.example/v" } }),
    };
    await expect(
      generate(notMp4, video(5), [], undefined, undefined, () =>
        Promise.resolve(new Response(png)),
      ),
    ).rejects.toMatchObject({ stage: "normalization" });
  });

  describe("reference images", () => {
    const withReferences = (count: number) =>
      validateMediaGenerationSettings({
        model: "openai/gpt-image-2",
        prompt: "the same heroine at a bus stop",
        width: 1024,
        height: 1024,
        references: Array.from({ length: count }, (_, index) => ({
          computerId: "pictures",
          path: `/refs/hero-${String(index)}.png`,
        })),
      });
    const bytes = (count: number) =>
      Array.from({ length: count }, () => ({
        bytes: png,
        format: "png" as const,
        width: 1,
        height: 1,
      }));
    const dataUri = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;

    it("keeps image sizes and dimension ceilings to what Cloudflare documents", () => {
      // https://developers.cloudflare.com/ai/models/openai/gpt-image-2/schema-input.json:
      // `size` is auto or WIDTHxHEIGHT, edges at most 3840 and multiples of 16,
      // ratio between 1:3 and 3:1, 655,360 to 8,294,400 pixels (no enum).
      const sizes = getMediaModel("openai/gpt-image-2")?.sizes ?? [];
      expect(sizes).toHaveLength(16);
      for (const size of ["1024x1024", "1024x1536", "1536x1024"])
        expect(sizes).toContain(size);
      for (const size of sizes) {
        const [width = 0, height = 0] = size.split("x").map(Number);
        expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
        expect(width % 16).toBe(0);
        expect(height % 16).toBe(0);
        expect(width / height).toBeGreaterThanOrEqual(1 / 3);
        expect(width / height).toBeLessThanOrEqual(3);
        expect(width * height).toBeGreaterThanOrEqual(655_360);
        expect(width * height).toBeLessThanOrEqual(8_294_400);
      }
      // Every common ratio is there, exactly, at a standard and a largest size.
      const proportions = new Set(
        sizes.map((size) => {
          const [width = 0, height = 0] = size.split("x").map(Number);
          return (width / height).toFixed(4);
        }),
      );
      for (const [across, down] of [
        [1, 1],
        [4, 3],
        [3, 4],
        [3, 2],
        [2, 3],
        [16, 9],
        [9, 16],
        [21, 9],
      ] as const)
        expect(proportions).toContain((across / down).toFixed(4));
      // https://developers.cloudflare.com/workers-ai/models/lucid-origin/ width/height maximum 2500.
      expect(
        getMediaModel("@cf/leonardo/lucid-origin")?.input.maxDimension,
      ).toBe(2500);
      // https://developers.cloudflare.com/workers-ai/models/phoenix-1.0/ width/height range 0 to 2048.
      expect(
        getMediaModel("@cf/leonardo/phoenix-1.0")?.input.maxDimension,
      ).toBe(2048);
    });

    it("declares each model's own reference limit from its provider docs", () => {
      expect(getMediaModel("openai/gpt-image-2")?.input).toMatchObject({
        maxReferences: 16,
        referenceField: "images",
      });
      expect(getMediaModel("openai/gpt-image-2")?.input).toMatchObject({
        referenceDimension: 1024,
        referenceFormat: "webp",
      });
      expect(
        getMediaModel("@cf/black-forest-labs/flux-2-klein-4b")?.input,
      ).toMatchObject({ referenceDimension: 512, referenceFormat: "png" });
      expect(
        getMediaModel("@cf/black-forest-labs/flux-1-schnell")?.input
          .maxReferences,
      ).toBe(0);
      expect(
        getMediaModel("@cf/black-forest-labs/flux-2-klein-4b")?.input
          .maxReferences,
      ).toBe(4);
      for (const model of listMediaModels())
        expect(model.input.maxReferences > 0).toBe(
          model.input.referenceField !== null,
        );
    });

    it("builds GPT Image 2's documented images[] data-URI body for N references", () => {
      const input = gatewayInput(withReferences(3), bytes(3));
      expect(input).toEqual({
        prompt: "the same heroine at a bus stop",
        size: "1024x1024",
        quality: "medium",
        output_format: "png",
        images: [dataUri, dataUri, dataUri],
      });
    });

    it("sends sixteen references and refuses a seventeenth, never truncating", () => {
      const sixteen = gatewayInput(withReferences(16), bytes(16));
      expect(
        z.object({ images: z.array(z.string()) }).parse(sixteen).images,
      ).toHaveLength(16);
      expect(() => withReferences(17)).toThrow(
        "openai/gpt-image-2 accepts at most 16 reference images",
      );
      expect(() =>
        validateMediaGenerationSettings({
          model: "@cf/black-forest-labs/flux-2-klein-4b",
          prompt: "x",
          width: 512,
          height: 512,
          references: Array.from({ length: 5 }, (_, index) => ({
            computerId: "pictures",
            path: `/refs/${String(index)}.png`,
          })),
        }),
      ).toThrow("accepts at most 4 reference images");
    });

    it("refuses references the model does not take and mismatched bytes", () => {
      expect(() =>
        validateMediaGenerationSettings({
          model: "@cf/black-forest-labs/flux-1-schnell",
          prompt: "x",
          width: 512,
          height: 512,
          references: [{ computerId: "pictures", path: "/a.png" }],
        }),
      ).toThrow("accepts at most 0 reference images");
      expect(() => gatewayInput(withReferences(2), bytes(1))).toThrow(
        "must match every admitted reference",
      );
      expect(() =>
        gatewayInput(withReferences(1), [
          { bytes: png, format: "gif", width: 1, height: 1 },
        ]),
      ).toThrow("not gif");
    });

    // Image inputs bypass the AI Gateway route (see routedOptions in cloudflare/provider.ts).
    it("dispatches the references on the direct binding with a fake transport", async () => {
      const settings = withReferences(2);
      const run = vi.fn(() =>
        Promise.resolve({
          state: "Completed",
          result: { image: "https://results.example/image" },
        }),
      );
      await generate(
        { run },
        settings,
        bytes(2),
        undefined,
        { gateway: { id: "fungi-hub" } },
        () => Promise.resolve(new Response(png)),
      );
      expect(run).toHaveBeenCalledWith(
        "openai/gpt-image-2",
        expect.objectContaining({ images: [dataUri, dataUri] }),
        {},
      );
    });

    it("bills each reference at the image input rate with OpenAI's high-fidelity bound", () => {
      const base = estimateGatewayMilliunits(withReferences(0), []);
      // 512 square: 65 + 129 + 4,160 image tokens at $8/M, + 1 text token at $5/M.
      expect(
        estimateGatewayMilliunits(withReferences(1), [
          { width: 512, height: 512 },
        ]),
      ).toBe(Math.ceil((1056 * 30 + 30 * 5 + 1 * 5 + 4354 * 8) / 10));
      // 512 x 384: one tile, non-square adds 6,240.
      expect(
        estimateGatewayMilliunits(withReferences(1), [
          { width: 512, height: 384 },
        ]),
      ).toBe(Math.ceil((1056 * 30 + 30 * 5 + 1 * 5 + 6434 * 8) / 10));
      // 2048 x 1024 scales to 1024 x 512: two tiles.
      expect(
        estimateGatewayMilliunits(withReferences(1), [
          { width: 2048, height: 1024 },
        ]),
      ).toBe(Math.ceil((1056 * 30 + 30 * 5 + 1 * 5 + 6563 * 8) / 10));
      // 1024 x 1024 (a fitted GPT Image 2 reference) caps the short side at
      // 512: one tile, the same bill as 512 square.
      expect(
        estimateGatewayMilliunits(withReferences(1), [
          { width: 1024, height: 1024 },
        ]),
      ).toBe(Math.ceil((1056 * 30 + 30 * 5 + 1 * 5 + 4354 * 8) / 10));
      // 1024 x 768 scales to 683 x 512: two tiles across, one down.
      expect(
        estimateGatewayMilliunits(withReferences(1), [
          { width: 1024, height: 768 },
        ]),
      ).toBe(Math.ceil((1056 * 30 + 30 * 5 + 1 * 5 + 6563 * 8) / 10));
      expect(base).toBe(Math.ceil((1056 * 30 + 30 * 5) / 10));
      expect(() => estimateGatewayMilliunits(withReferences(2), [])).toThrow(
        "must match every admitted reference",
      );
    });
  });
});

describe("GPT Image 2 sizes", () => {
  const sized = (size: string) => {
    const [width, height] = size.split("x").map(Number);
    return validateMediaGenerationSettings({
      model: "openai/gpt-image-2",
      prompt: "a seed catalogue cover",
      width: width ?? 0,
      height: height ?? 0,
    });
  };

  it("sends each catalog size as the provider's WIDTHxHEIGHT", () => {
    for (const size of getMediaModel("openai/gpt-image-2")?.sizes ?? [])
      expect(gatewayInput(sized(size))).toMatchObject({ size });
    expect(() => sized("1000x1000")).toThrow("accepts only these sizes");
  });

  it("quotes the table's sizes exactly and others by their pixels", () => {
    // 22 prompt characters at $5/M, bounded as one token each.
    const per = (size: string) => estimateGatewayMilliunits(sized(size), []);
    const expected = (tokens: number) => Math.ceil((tokens * 30 + 22 * 5) / 10);
    expect(per("1024x1024")).toBe(expected(1056));
    expect(per("1536x1024")).toBe(expected(1568));
    // 16:9 at 3840x2160 is 8,294,400 pixels: 8,354 tokens at $30/M.
    expect(per("3840x2160")).toBe(expected(8_354));
    expect(per("1280x720")).toBe(expected(929));
    expect(per("3840x2160")).toBeGreaterThan(per("1280x720"));
  });
});

describe("Seedance 2.5", () => {
  const id = "bytedance/seedance-2.5";
  const clip = (
    durationSeconds: number,
    size = "1280x720",
    extra: Partial<Parameters<typeof validateMediaGenerationSettings>[0]> = {},
  ) => {
    const [width, height] = size.split("x").map(Number);
    return validateMediaGenerationSettings({
      model: id,
      prompt: "fern fronds unfurling",
      width: width ?? 0,
      height: height ?? 0,
      durationSeconds,
      ...extra,
    });
  };

  it("lists the plain name and the documented bounds", () => {
    const model = getMediaModel(id);
    expect(model?.label).toBe("Seedance 2.5");
    expect(model?.maxPromptLength).toBe(25_000);
    expect(model?.video).toMatchObject({
      minSeconds: 4,
      maxSeconds: 30,
      defaultSeconds: 5,
      provider: "seedance",
      supportsAudio: true,
      maxReferenceImages: 30,
    });
    expect(model?.video?.durations).toHaveLength(27);
    const formats = model?.video?.formats ?? [];
    expect(new Set(formats.map((format) => format.resolution))).toEqual(
      new Set(["480p", "720p"]),
    );
    expect(formats.map((format) => format.aspectRatio)).not.toContain("9:21");
    // Seedance 2.0 models stay listed.
    for (const kept of ["", "-fast", "-mini"])
      expect(getMediaModel(`bytedance/seedance-2.0${kept}`)).toBeDefined();
  });

  it("accepts 4 to 30 seconds and refuses the rest", () => {
    expect(clip(30).durationSeconds).toBe(30);
    expect(() => clip(3)).toThrow("durationSeconds");
    expect(() => clip(31)).toThrow("durationSeconds");
    expect(() => clip(5, "1000x720")).toThrow("accepts only these sizes");
  });

  it("builds the documented request body without inventing fields", () => {
    expect(gatewayInput(clip(30, "720x1280", { generateAudio: true }))).toEqual(
      {
        prompt: "fern fronds unfurling",
        duration: 30,
        resolution: "720p",
        aspect_ratio: "9:16",
        generate_audio: true,
      },
    );
    const framed = z
      .object({ image: z.string(), last_frame_image: z.string() })
      .parse(
        gatewayInput(
          clip(8, "1280x720", {
            references: [
              { computerId: "pictures", path: "a.png", role: "first-frame" },
              { computerId: "pictures", path: "b.png", role: "last-frame" },
            ],
          }),
          [
            { bytes: png, format: "png", width: 1, height: 1 },
            { bytes: png, format: "png", width: 1, height: 1 },
          ],
        ),
      );
    expect(framed.image.startsWith("data:image/png;base64,")).toBe(true);
    expect(framed.last_frame_image.startsWith("data:image/png;base64,")).toBe(
      true,
    );
  });

  it("quotes a 5 second 720p clip at the dashboard rate", () => {
    // $0.2312/s at 720p (non-video input), 1 USD = 100,000 milliunits.
    expect(estimateGatewayMilliunits(clip(5), [])).toBe(115_600);
    // $0.1028/s at 480p.
    expect(estimateGatewayMilliunits(clip(5, "854x480"), [])).toBe(51_400);
  });
});
