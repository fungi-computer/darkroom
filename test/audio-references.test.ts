import { describe, expect, it, vi } from "vitest";
import {
  getMediaModel,
  listMediaModels,
  mediaVideoModelIdSchema,
  validateMediaGenerationSettings,
  validateMediaVideoSelection,
  MediaSettingsError,
  type MediaGenerationSettings,
} from "../src/index.js";
import { resolveMediaAudioReferences } from "../src/audio-references.js";
import { gatewayInput } from "../src/gateway-models.js";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";
import type { MediaProvider } from "../src/index.js";
import { createMediaService } from "../src/server.js";
import { MediaOperationOwner } from "../src/media-operation-owner.js";
import { mediaOperationFixture } from "./fixtures/media-operation.fixture.js";
import { mediaModelsSchema } from "../src/app-media-contracts.js";
import {
  mediaBindingRequest,
  parseMediaBindingCall,
} from "../src/media-binding.js";

/** A silent 8 kHz mono 8-bit PCM WAV of `seconds` seconds: test fixture bytes, not a parser. */
function wav(seconds: number): Uint8Array {
  const rate = 8_000;
  const data = Math.round(seconds * rate);
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, data, true);
  bytes.fill(128, 44);
  return bytes;
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const seedance25 = "bytedance/seedance-2.5";
/** Validated video settings for any video model, with optional hydrated audio clips. */
const video = (
  model: string,
  paths?: readonly string[],
): MediaGenerationSettings =>
  validateMediaGenerationSettings({
    ...validateMediaVideoSelection({
      model: mediaVideoModelIdSchema.parse(model),
      prompt: "a fern",
    }),
    references: undefined,
    audioReferences: paths?.map((path) => ({ computerId: "pictures", path })),
  });
const withAudio = (paths: readonly string[]) => video(seedance25, paths);
const readerOf = (clips: Record<string, Uint8Array>) => ({
  read: vi.fn((reference: { path: string }) => {
    const bytes = clips[reference.path];
    if (bytes === undefined) throw new Error("missing clip");
    return Promise.resolve(bytes);
  }),
});

describe("reference audio admission", () => {
  it.each([
    "bytedance/seedance-2.0",
    "bytedance/seedance-2.0-fast",
    "bytedance/seedance-2.0-mini",
    "google/veo-3.1",
    "google/veo-3.1-fast",
    "minimax/h3-max",
  ])("refuses audio references on %s, which declares none", (model) => {
    expect(getMediaModel(model)?.video?.audioReferences).toBeNull();
    expect(() => video(model, ["/a.wav"])).toThrow(
      "does not take audio references",
    );
  });

  it("refuses audio references on an image or audio model", () => {
    expect(() =>
      validateMediaGenerationSettings({
        model: "openai/gpt-image-2",
        prompt: "x",
        width: 1024,
        height: 1024,
        audioReferences: [{ computerId: "c", path: "/a.wav" }],
      }),
    ).toThrow("does not take audio references");
    expect(() =>
      validateMediaGenerationSettings({
        model: "elevenlabs/music-v2",
        prompt: "x",
        audioReferences: [{ computerId: "c", path: "/a.wav" }],
      }),
    ).toThrow("takes only a prompt");
  });

  it("admits up to the model's ten clips and refuses an eleventh before anything is read", () => {
    expect(
      withAudio(
        Array.from({ length: 10 }, (_, index) => `/${String(index)}.wav`),
      ).audioReferences,
    ).toHaveLength(10);
    expect(() =>
      validateMediaVideoSelection({
        model: seedance25,
        prompt: "a fern",
        audioReferences: Array.from({ length: 11 }, (_, index) => ({
          path: `/${String(index)}.wav`,
        })),
      }),
    ).toThrow(MediaSettingsError);
  });
});

describe("reference audio budget", () => {
  it("reads each clip's duration with the parser and accepts exactly 30 seconds", async () => {
    const reader = readerOf({
      "/a.wav": wav(10),
      "/b.wav": wav(10),
      "/c.wav": wav(10),
    });
    const clips = await resolveMediaAudioReferences(
      withAudio(["/a.wav", "/b.wav", "/c.wav"]),
      reader,
    );
    expect(clips.map((clip) => clip.durationSeconds)).toEqual([10, 10, 10]);
    expect(clips.every((clip) => clip.mimeType === "audio/wav")).toBe(true);
  });

  it("refuses a total over 30 seconds instead of dropping a clip", async () => {
    await expect(
      resolveMediaAudioReferences(
        withAudio(["/a.wav", "/b.wav"]),
        readerOf({ "/a.wav": wav(15), "/b.wav": wav(15.5) }),
      ),
    ).rejects.toThrow("total 30.5 seconds; the limit is 30");
  });

  it("refuses bytes that are not audio, and an empty file", async () => {
    await expect(
      resolveMediaAudioReferences(
        withAudio(["/a.wav"]),
        readerOf({ "/a.wav": new TextEncoder().encode("not audio at all") }),
      ),
    ).rejects.toBeInstanceOf(MediaSettingsError);
    await expect(
      resolveMediaAudioReferences(
        withAudio(["/a.wav"]),
        readerOf({ "/a.wav": new Uint8Array() }),
      ),
    ).rejects.toThrow("unavailable or exceeds");
  });

  it("returns nothing when no audio reference is selected", async () => {
    const reader = readerOf({});
    await expect(
      resolveMediaAudioReferences(video(seedance25), reader),
    ).resolves.toEqual([]);
    expect(reader.read).not.toHaveBeenCalled();
  });
});

describe("Seedance 2.5 reference_audios", () => {
  it("sends data:audio URIs of the exact bytes and nothing else new", async () => {
    const clip = wav(2);
    const settings = withAudio(["/a.wav"]);
    const clips = await resolveMediaAudioReferences(
      settings,
      readerOf({ "/a.wav": clip }),
    );
    const body = gatewayInput(settings, [], "png", clips);
    expect(body).toMatchObject({
      prompt: "a fern",
      reference_audios: [`data:audio/wav;base64,${base64(clip)}`],
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        "aspect_ratio",
        "duration",
        "generate_audio",
        "prompt",
        "reference_audios",
        "resolution",
      ].sort(),
    );
    expect(gatewayInput(video(seedance25))).not.toHaveProperty(
      "reference_audios",
    );
  });

  it("refuses resolved clips that do not match the admitted references", () => {
    expect(() => gatewayInput(withAudio(["/a.wav"]), [], "png", [])).toThrow(
      "must match every admitted audio reference",
    );
  });
});

describe("reference audio through the MEDIA binding and catalog", () => {
  it("attaches the selected Computer to each clip", () => {
    const parsed = parseMediaBindingCall({
      operation: "generate",
      input: {
        kind: "video",
        requestId: "media_request_abcdefghijklmnopqrstu",
        libraryPath: "/workspace/prints",
        settings: {
          model: seedance25,
          prompt: "a fern",
          audioReferences: [{ path: "/workspace/prints/a.wav" }],
        },
      },
    });
    if (parsed.kind !== "parsed" || parsed.call.operation !== "generate")
      throw new Error("video call was refused");
    expect(
      mediaBindingRequest(parsed.call.input, "computer-1").settings
        .audioReferences,
    ).toEqual([{ path: "/workspace/prints/a.wav", computerId: "computer-1" }]);
  });

  it("lists audioReferences only when the host can read clips", async () => {
    const fixture = mediaOperationFixture();
    try {
      const listed = async (readable: boolean) => {
        const destination = {
          authorize: () => Promise.resolve(),
          write: () => Promise.resolve(),
          readReference: () => Promise.reject(new Error("unused")),
        };
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
          destination: readable
            ? {
                ...destination,
                readAudioReference: () => Promise.resolve(wav(1)),
              }
            : destination,
        });
        const models = mediaModelsSchema.parse(
          await (await service.request("/models")).json(),
        );
        return models.find((model) => model.id === seedance25)?.video
          ?.audioReferences;
      };
      expect(await listed(true)).toEqual({ max: 10, totalSeconds: 30 });
      expect(await listed(false)).toBeNull();
    } finally {
      fixture.close();
    }
    expect(
      listMediaModels().find((model) => model.id === seedance25)?.video
        ?.audioReferences,
    ).toEqual({ max: 10, totalSeconds: 30 });
  });
});

describe("reference audio through the durable background service", () => {
  it("retains the clips for the alarm, sends them once, and deletes them", async () => {
    const clip = wav(3);
    const run = vi.fn(() =>
      Promise.resolve({
        state: "Completed",
        result: { video: "https://results.example/clip.mp4" },
      }),
    );
    const ai: MediaAiPort = { run };
    const mp4 = Uint8Array.from([
      0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
      0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
    ]);
    const provider: MediaProvider = (
      selection,
      references,
      signal,
      format,
      audioReferences,
    ) =>
      generate(
        ai,
        selection,
        references,
        signal,
        undefined,
        () => Promise.resolve(new Response(mp4)),
        format,
        audioReferences,
      );
    const outputs = new Map<string, Uint8Array>();
    const fixture = mediaOperationFixture(":memory:", outputs);
    try {
      const owner = new MediaOperationOwner(
        fixture.context,
        { APP_ARTIFACTS: fixture.bucket },
        () => provider,
      );
      const reads = vi.fn(() => Promise.resolve(clip));
      const service = createMediaService({
        scope: {
          actorId: "actor",
          namespace: "team",
          owner: "installation",
          destinationId: "computer",
        },
        operations: { getByName: () => owner },
        provider,
        metering: "unmetered",
        destination: {
          authorize: () => Promise.resolve(),
          write: () => Promise.resolve(),
          readAudioReference: reads,
        },
      });
      const request = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "audio-reference-video",
        },
        body: JSON.stringify({
          path: "generated/fern.mp4",
          settings: {
            model: seedance25,
            prompt: "a fern",
            width: 1280,
            height: 720,
            durationSeconds: 5,
            audioReferences: [{ computerId: "computer", path: "/a.wav" }],
          },
        }),
      };
      expect((await service.request("/generate", request)).status).toBe(202);
      expect([...outputs.keys()].some((key) => key.includes("audio"))).toBe(
        true,
      );
      await owner.alarm();
      expect((await service.request("/generate", request)).status).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(
        seedance25,
        expect.objectContaining({
          reference_audios: [`data:audio/wav;base64,${base64(clip)}`],
        }),
        undefined,
      );
      expect([...outputs.keys()].some((key) => key.includes("audio"))).toBe(
        false,
      );
    } finally {
      fixture.close();
    }
  });

  it("refuses an over-budget clip set before billing or dispatch", async () => {
    const admit = vi.fn(() => Promise.resolve({ priceMilliunits: 1 }));
    const provider = vi.fn();
    const fixture = mediaOperationFixture();
    try {
      const service = createMediaService({
        scope: {
          actorId: "actor",
          namespace: "team",
          owner: "installation",
          destinationId: "computer",
        },
        operations: { getByName: () => fixture.owner },
        provider,
        metering: { admit, settle: () => Promise.resolve() },
        refusalMessages: {
          insufficient_credits: "refill",
          denied: "denied",
          daily_limit_reached: "daily limit",
        },
        destination: {
          authorize: () => Promise.resolve(),
          write: () => Promise.resolve(),
          readAudioReference: () => Promise.resolve(wav(31)),
        },
      });
      const response = await service.request("/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "audio-reference-over",
        },
        body: JSON.stringify({
          path: "generated/fern.mp4",
          settings: {
            model: seedance25,
            prompt: "a fern",
            width: 1280,
            height: 720,
            durationSeconds: 5,
            audioReferences: [{ computerId: "computer", path: "/a.wav" }],
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(admit).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });
});
