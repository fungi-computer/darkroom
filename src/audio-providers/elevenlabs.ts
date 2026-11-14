import { z } from "zod";
import {
  MediaSettingsError,
  type MediaAudioModel,
  type MediaModel,
} from "../model-catalog.js";
import type { MediaAiResult, MediaGenerationSettings } from "../index.js";
import { resultUrl } from "../gateway-wire.js";

/**
 * ElevenLabs on Cloudflare's Unified Billing. Every shape below is the model
 * page's own `schema-input.json` / `schema-output.json`, checked 2026-11-13:
 * https://developers.cloudflare.com/ai/models/elevenlabs/eleven-v3/
 * https://developers.cloudflare.com/ai/models/elevenlabs/eleven-multilingual-v2/
 * https://developers.cloudflare.com/ai/models/elevenlabs/music-v2/
 */

/**
 * `mp3_44100_128` is in the `output_format` enum of every ElevenLabs model
 * page above. It is requested explicitly so the saved file is always an MP3.
 */
const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

/** A text-to-speech request: `text` (1-10,000 characters) and a required `voice_id`. */
export type ElevenLabsSpeechInput = {
  text: string;
  voice_id: string;
  output_format: typeof ELEVENLABS_OUTPUT_FORMAT;
};
/** A music request: a `prompt` and `music_length_ms` of 3,000 through 600,000. */
export type ElevenLabsMusicInput = {
  prompt: string;
  music_length_ms: number;
  output_format: typeof ELEVENLABS_OUTPUT_FORMAT;
};
/** Every ElevenLabs request body this catalog can produce. */
export type ElevenLabsInput = ElevenLabsSpeechInput | ElevenLabsMusicInput;

/**
 * The one shape a live Unified Billing call returned for Multilingual v2, v3
 * and Music v2 (2026-11-13, REST envelope `{result: ...}` removed by the
 * binding): `{state: "Completed", result: {audio: <HTTPS URL>}}`, the same
 * wrapper Seedance and Veo use. The audio is a URL to fetch, not bytes. The
 * model pages' bare `{audio}` schema-output is not what the gateway answers
 * and is refused.
 */
const elevenLabsOutputSchema = z.lazy(() =>
  z.looseObject({
    state: z.literal("Completed"),
    result: z.looseObject({ audio: resultUrl }),
  }),
);

/** Results are fetched whole; 600 seconds of 128 kbps MP3 is about 10 MB. */
export const ELEVENLABS_MAX_BYTES = 32 * 1024 * 1024;

function audioOf(model: MediaModel): MediaAudioModel {
  if (model.audio === null)
    throw new MediaSettingsError(`${model.id} is not an audio model`);
  return model.audio;
}

/** The exact provider JSON body for one validated speech or music generation. */
export function buildElevenLabsInput(
  settings: MediaGenerationSettings,
  model: MediaModel,
): ElevenLabsInput {
  const audio = audioOf(model);
  if (audio.mode === "speech") {
    if (settings.voiceId === undefined)
      throw new MediaSettingsError(`${model.id} needs a voice`);
    return {
      text: settings.prompt,
      voice_id: settings.voiceId,
      output_format: ELEVENLABS_OUTPUT_FORMAT,
    };
  }
  if (settings.durationSeconds === undefined)
    throw new MediaSettingsError(`${model.id} needs a length`);
  return {
    prompt: settings.prompt,
    music_length_ms: settings.durationSeconds * 1_000,
    output_format: ELEVENLABS_OUTPUT_FORMAT,
  };
}

/** Extract and validate the HTTPS result URL from the raw provider answer. */
export function decodeElevenLabsResultUrl(
  providerValue: MediaAiResult,
): string {
  return elevenLabsOutputSchema.parse(providerValue).result.audio;
}

/**
 * Provider cost in milliunits: speech is per character of text, music per
 * second of output length asked for (1 USD = 100,000 milliunits).
 */
export function estimateElevenLabsMilliunits(
  settings: MediaGenerationSettings,
  model: MediaModel,
): number {
  const audio = audioOf(model);
  const quantity =
    audio.mode === "speech" ? settings.prompt.length : settings.durationSeconds;
  if (quantity === undefined)
    throw new MediaSettingsError(`${model.id} needs a length`);
  return quantity * audio.milliunitsPerUnit;
}
