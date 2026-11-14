import { describe, expect, it, vi } from "vitest";
import {
  getMediaModel,
  listMediaModels,
  parseMediaCatalogue,
  validateMediaGenerationSettings,
} from "../src/index.js";
import {
  estimateGatewayMilliunits,
  gatewayInput,
  mediaUnits,
} from "../src/gateway-models.js";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";
import type { MediaProvider } from "../src/index.js";
import { createMediaService } from "../src/server.js";
import { MediaOperationOwner } from "../src/media-operation-owner.js";
import { mediaOperationFixture } from "./fixtures/media-operation.fixture.js";
import {
  mediaBindingRequest,
  parseMediaBindingCall,
} from "../src/media-binding.js";

/** The only voice Cloudflare's ElevenLabs pages list. */
const voice = "JBFqnCBsd6RMkjVDRZzb";
const speechModels = [
  "elevenlabs/eleven-multilingual-v2",
  "elevenlabs/eleven-v3",
] as const;
const music = "elevenlabs/music-v2";
const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);

const speech = (model: string = speechModels[0], prompt = "Hello fern.") =>
  validateMediaGenerationSettings({ model, prompt });
const song = (durationSeconds?: number) => {
  const input: Parameters<typeof validateMediaGenerationSettings>[0] = {
    model: music,
    prompt: "a slow kalimba theme",
  };
  if (durationSeconds !== undefined) input.durationSeconds = durationSeconds;
  return validateMediaGenerationSettings(input);
};

describe("ElevenLabs audio models", () => {
  it("lists three audio models with the documented bounds and rates", () => {
    const audio = listMediaModels().filter((model) => model.kind === "audio");
    expect(audio.map((model) => model.id)).toEqual([...speechModels, music]);
    for (const id of speechModels) {
      const model = getMediaModel(id);
      expect(model?.maxPromptLength).toBe(10_000);
      expect(model?.audio?.voices.map((entry) => entry.id)).toEqual([voice]);
    }
    // Multilingual v2 and v3 list $0.0001 per character.
    expect(getMediaModel(speechModels[0])?.audio?.milliunitsPerUnit).toBe(10);
    expect(getMediaModel(speechModels[1])?.audio?.milliunitsPerUnit).toBe(10);
    // Eleven Flash answers 403 code 2047 (BYOK only) on Unified Billing.
    expect(getMediaModel("elevenlabs/eleven-flash-v2-5")).toBeUndefined();
    expect(getMediaModel(music)?.audio).toMatchObject({
      mode: "music",
      voices: [],
      seconds: { min: 3, max: 600, default: 30 },
      milliunitsPerUnit: 250,
    });
  });

  it("normalizes speech to its default voice and refuses everything else", () => {
    expect(speech()).toEqual({
      model: speechModels[0],
      prompt: "Hello fern.",
      voiceId: voice,
    });
    expect(() =>
      validateMediaGenerationSettings({
        model: speechModels[0],
        prompt: "x",
        voiceId: "not-a-listed-voice",
      }),
    ).toThrow("accepts only these voices");
    for (const extra of [
      { width: 1024 },
      { height: 1024 },
      { steps: 4 },
      { generateAudio: true },
      { references: [{ computerId: "c", path: "/a.png" }] },
    ])
      expect(() =>
        validateMediaGenerationSettings({
          model: speechModels[0],
          prompt: "x",
          ...extra,
        }),
      ).toThrow("takes only a prompt and a voice");
    expect(() =>
      validateMediaGenerationSettings({
        model: speechModels[0],
        prompt: "x",
        durationSeconds: 5,
      }),
    ).toThrow("does not take a duration");
    expect(() => speech(speechModels[0], "x".repeat(10_001))).toThrow(
      "limit is 10000",
    );
  });

  it("bounds music length to 3 through 600 seconds and refuses a voice", () => {
    expect(song()).toMatchObject({ durationSeconds: 30 });
    expect(song(3)).toMatchObject({ durationSeconds: 3 });
    expect(song(600)).toMatchObject({ durationSeconds: 600 });
    expect(() => song(2)).toThrow("durationSeconds");
    expect(() => song(601)).toThrow("durationSeconds");
    expect(() =>
      validateMediaGenerationSettings({
        model: music,
        prompt: "x",
        voiceId: voice,
      }),
    ).toThrow("does not take a voice");
    expect(() =>
      validateMediaGenerationSettings({
        model: "openai/gpt-image-2",
        prompt: "x",
        width: 1024,
        height: 1024,
        voiceId: voice,
      }),
    ).toThrow("does not take a voice");
  });

  it("builds each provider body from its documented schema", () => {
    expect(gatewayInput(speech(speechModels[1], "Hi"))).toEqual({
      text: "Hi",
      voice_id: voice,
      output_format: "mp3_44100_128",
    });
    expect(gatewayInput(song(45))).toEqual({
      prompt: "a slow kalimba theme",
      music_length_ms: 45_000,
      output_format: "mp3_44100_128",
    });
  });

  it("bills speech per 100-character block and music per second", () => {
    expect(mediaUnits(speech(speechModels[0], "x".repeat(100)))).toEqual({
      unit: "audio_character_block",
      units: 1,
    });
    expect(mediaUnits(speech(speechModels[0], "x".repeat(101)))).toEqual({
      unit: "audio_character_block",
      units: 2,
    });
    expect(mediaUnits(song(45))).toEqual({ unit: "audio_second", units: 45 });
  });

  it("quotes published rates in milliunits", () => {
    // 100 characters at $0.0001; 45 seconds at $0.0025.
    expect(
      estimateGatewayMilliunits(speech(speechModels[0], "x".repeat(100)), []),
    ).toBe(1_000);
    expect(
      estimateGatewayMilliunits(speech(speechModels[1], "x".repeat(100)), []),
    ).toBe(1_000);
    expect(estimateGatewayMilliunits(song(45), [])).toBe(11_250);
  });

  /** The inner value of a live Unified Billing answer (2026-11-13), URL host abbreviated. */
  const liveAnswer = {
    state: "Completed",
    result: {
      audio:
        "https://ai-gateway-outputs.example.r2.cloudflarestorage.com/a.mp3",
    },
  };

  it("dispatches through the gateway and saves the fetched MP3", async () => {
    const settings = speech(speechModels[0], "Hello fern.");
    const run = vi.fn(() => Promise.resolve(liveAnswer));
    const fetchResult = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(mp3)),
    );
    await expect(
      generate(
        { run },
        settings,
        [],
        undefined,
        { gateway: { id: "fungi-hub" } },
        fetchResult,
      ),
    ).resolves.toEqual({ bytes: mp3, format: "mp3" });
    expect(run).toHaveBeenCalledWith(
      speechModels[0],
      {
        text: "Hello fern.",
        voice_id: voice,
        output_format: "mp3_44100_128",
      },
      { gateway: { id: "fungi-hub" } },
    );
    expect(fetchResult.mock.calls[0]?.[0]).toBe(liveAnswer.result.audio);
  });

  it("sends music as prompt plus music_length_ms and reads the same answer", async () => {
    const run = vi.fn(() => Promise.resolve(liveAnswer));
    await generate({ run }, song(12), [], undefined, undefined, () =>
      Promise.resolve(new Response(mp3)),
    );
    expect(run).toHaveBeenCalledWith(
      music,
      {
        prompt: "a slow kalimba theme",
        music_length_ms: 12_000,
        output_format: "mp3_44100_128",
      },
      undefined,
    );
  });

  it.each([
    ["the bare schema shape", { audio: "https://results.example/a.mp3" }],
    [
      "a non-HTTPS URL",
      { state: "Completed", result: { audio: "http://results.example/a.mp3" } },
    ],
    ["no audio field", { state: "Completed", result: {} }],
    [
      "a state that is not Completed",
      { state: "Failed", result: { audio: "https://x.example/a" } },
    ],
  ])("refuses %s", async (_name, answer) => {
    const fetchResult = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(mp3)),
    );
    await expect(
      generate(
        { run: () => Promise.resolve(answer) },
        speech(),
        [],
        undefined,
        undefined,
        fetchResult,
      ),
    ).rejects.toMatchObject({ stage: "normalization" });
    expect(fetchResult).not.toHaveBeenCalled();
  });

  it("refuses a failed result download", async () => {
    await expect(
      generate(
        {
          run: () => Promise.resolve(liveAnswer),
        },
        speech(),
        [],
        undefined,
        undefined,
        () => Promise.resolve(new Response("gone", { status: 404 })),
      ),
    ).rejects.toMatchObject({
      stage: "normalization",
      provider: { category: "result_download", status: 404 },
    });
  });
});

describe("a host catalogue", () => {
  const entry = {
    ...structuredClone(getMediaModel(speechModels[0])),
    audio: undefined,
  };
  it("carries audio bounds exactly when the kind is audio", () => {
    expect(() => parseMediaCatalogue([entry])).toThrow(
      "must carry audio bounds exactly when kind is audio",
    );
    expect(
      parseMediaCatalogue([getMediaModel(speechModels[0])])[0]?.audio?.mode,
    ).toBe("speech");
  });
});

describe("audio references", () => {
  it("are declared only by Seedance 2.5, at 10 clips and 30 seconds", () => {
    const declared = listMediaModels()
      .filter((model) => model.video?.audioReferences != null)
      .map((model) => [model.id, model.video?.audioReferences]);
    expect(declared).toEqual([
      ["bytedance/seedance-2.5", { max: 10, totalSeconds: 30 }],
    ]);
  });
});

describe("audio through the MEDIA binding", () => {
  const call = (settings: Record<string, string | number>) =>
    parseMediaBindingCall({
      operation: "generate",
      input: {
        kind: "audio",
        requestId: "media_request_abcdefghijklmnopqrstu",
        libraryPath: "/workspace/prints",
        settings,
      },
    });

  it("writes speech and music to an .mp3 under the App's folder", () => {
    for (const settings of [
      { model: speechModels[0], prompt: "Hi" },
      { model: music, prompt: "theme", durationSeconds: 12 },
    ]) {
      const parsed = call(settings);
      if (parsed.kind !== "parsed" || parsed.call.operation !== "generate")
        throw new Error("audio call was refused");
      const request = mediaBindingRequest(parsed.call.input, "computer-1");
      expect(request.path).toBe(
        "/workspace/prints/prints-media_request_abcdefghijklmnopqrstu.mp3",
      );
      expect(request.settings).not.toHaveProperty("references");
    }
  });

  it("refuses an unlisted model, an unlisted voice and image settings", () => {
    for (const settings of [
      { model: "elevenlabs/sfx", prompt: "boom" },
      { model: speechModels[0], prompt: "Hi", voiceId: "nope" },
      { model: speechModels[0], prompt: "Hi", width: 1024 },
      { model: music, prompt: "theme", durationSeconds: 601 },
    ])
      expect(call(settings)).toMatchObject({ kind: "refused" });
  });
});

describe("audio through the durable service", () => {
  it("runs in the background, bills blocks, saves the MP3 and replays", async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        state: "Completed",
        result: { audio: "https://results.example/voice.mp3" },
      }),
    );
    const ai: MediaAiPort = { run };
    const fetchResult: typeof fetch = () => Promise.resolve(new Response(mp3));
    const provider: MediaProvider = (selection, references, signal, format) =>
      generate(
        ai,
        selection,
        references,
        signal,
        undefined,
        fetchResult,
        format,
      );
    const fixture = mediaOperationFixture();
    const admit = vi.fn(({ units }: { units: number }) =>
      Promise.resolve({ priceMilliunits: units * 100 }),
    );
    const settle = vi.fn(() => Promise.resolve());
    const writes: Uint8Array[] = [];
    try {
      const owner = new MediaOperationOwner(
        fixture.context,
        { APP_ARTIFACTS: fixture.bucket },
        () => provider,
      );
      const service = createMediaService({
        scope: {
          actorId: "actor-audio",
          namespace: "team-audio",
          owner: "installation-audio",
          destinationId: "computer-audio",
        },
        operations: { getByName: () => owner },
        provider,
        metering: { admit, settle },
        refusalMessages: {
          insufficient_credits: "refill",
          denied: "denied",
          daily_limit_reached: "daily limit",
        },
        destination: {
          authorize: () => Promise.resolve(),
          write: (_path, bytes) => {
            writes.push(bytes);
            return Promise.resolve();
          },
        },
      });
      const request = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "audio-speech",
        },
        body: JSON.stringify({
          path: "generated/fern.mp3",
          settings: {
            model: speechModels[0],
            prompt: "x".repeat(150),
            voiceId: voice,
          },
        }),
      };
      expect((await service.request("/generate", request)).status).toBe(202);
      await owner.alarm();
      const done = await service.request("/generate", request);
      expect(done.status).toBe(200);
      expect(await done.json()).toMatchObject({
        format: "mp3",
        path: "generated/fern.mp3",
        model: speechModels[0],
        bytes: mp3.byteLength,
      });
      const replay = await service.request("/generate", request);
      expect(replay.status).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
      expect(writes).toEqual([mp3]);
      expect(admit).toHaveBeenCalledWith(
        expect.objectContaining({
          unit: "audio_character_block",
          units: 2,
          providerCostMilliunits: 1_500,
        }),
      );
      expect(settle).toHaveBeenCalledWith(
        expect.objectContaining({ units: 2 }),
      );
    } finally {
      fixture.close();
    }
  });
});
