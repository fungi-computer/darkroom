import { expect, it, vi } from "vitest";
import { z } from "zod";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";
import {
  getMediaModel,
  listMediaModels,
  validateMediaGenerationSettings,
} from "../src/index.js";
import { isGatewayModel } from "../src/gateway-models.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
).toString("base64");

const workersAiModels = listMediaModels()
  .map((model) => model.id)
  .filter((id) => !isGatewayModel(id));

it.each(workersAiModels)(
  "routes %s through the AI Gateway only when its input is not a stream",
  async (model) => {
    const run = vi.fn<MediaAiPort["run"]>().mockResolvedValue({ image: png });
    const signal = new AbortController().signal;
    const settings = validateMediaGenerationSettings({
      model,
      prompt: "fixture",
      width: 512,
      height: 512,
    });
    await generate({ run }, settings, [], signal, {
      gateway: { id: "default" },
    });
    expect(run).toHaveBeenCalledOnce();
    const [, input, options] = run.mock.calls[0] ?? [];
    expect(options?.signal).toBe(signal);
    const multipart = getMediaModel(model)?.input.transport === "multipart";
    expect(input !== undefined && "multipart" in input).toBe(multipart);
    expect(options?.gateway).toEqual(multipart ? undefined : { id: "default" });
  },
);

it("keeps flux-2 on its stream input and drops only the gateway option", async () => {
  const run = vi.fn<MediaAiPort["run"]>().mockResolvedValue({ image: png });
  await generate(
    { run },
    validateMediaGenerationSettings({
      model: "@cf/black-forest-labs/flux-2-klein-4b",
      prompt: "fixture",
      width: 1024,
      height: 768,
    }),
    [],
    undefined,
    { gateway: { id: "default" } },
  );
  const [, input, options] = run.mock.calls[0] ?? [];
  expect(() =>
    z
      .object({ multipart: z.object({ body: z.instanceof(ReadableStream) }) })
      .parse(input),
  ).not.toThrow();
  expect(options).toEqual({});
});

const video = validateMediaGenerationSettings({
  model: "bytedance/seedance-2.0-mini",
  prompt: "fern fronds unfurling",
  width: 854,
  height: 480,
  durationSeconds: 4,
});
const frame = Buffer.from(png, "base64");
const mp4 = Uint8Array.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
  0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
]);

it.each([
  ["a text-only video keeps", video, [], { id: "default" }],
  [
    "a first-frame video drops",
    {
      ...video,
      references: [
        {
          computerId: "pictures",
          path: "panel.png",
          role: "first-frame" as const,
        },
      ],
    },
    [{ bytes: frame, format: "png" as const, width: 1, height: 1 }],
    undefined,
  ],
])("%s the AI Gateway option", async (_, settings, references, gateway) => {
  const run = vi.fn<MediaAiPort["run"]>().mockResolvedValue({
    state: "Completed",
    result: { video: "https://results.example/clip.mp4" },
  });
  await expect(
    generate(
      { run },
      settings,
      references,
      undefined,
      { gateway: { id: "default" } },
      () => Promise.resolve(new Response(mp4)),
    ),
  ).resolves.toEqual({ bytes: mp4, format: "mp4" });
  const [, input, options] = run.mock.calls[0] ?? [];
  expect(input !== undefined && "image" in input).toBe(references.length > 0);
  expect(options?.gateway).toEqual(gateway);
});
