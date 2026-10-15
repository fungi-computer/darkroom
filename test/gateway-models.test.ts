import { describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { validateMediaGenerationSettings } from "../src/index.js";
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
    expect(estimateGatewayMilliunits(image())).toBe(
      Math.ceil((1584 * 30 + 22 * 5) / 10),
    );
    // Seedance 2.0 at 720p is $0.15/s; 480p is $0.07/s.
    expect(estimateGatewayMilliunits(video(5))).toBe(75_000);
    expect(estimateGatewayMilliunits(video(4, "854x480"))).toBe(28_000);
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
});
