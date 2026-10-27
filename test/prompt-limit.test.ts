import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_PROMPT_LENGTH,
  MediaSettingsError,
  listMediaModels,
  validateMediaGenerationSettings,
} from "../src/index.js";

const longPrompt = "a".repeat(6_531);

describe("per-model prompt limits", () => {
  it("exposes a documented limit on every catalog model, within the ceiling", () => {
    for (const model of listMediaModels()) {
      expect(model.maxPromptLength).toBeGreaterThan(0);
      expect(model.maxPromptLength).toBeLessThanOrEqual(
        MAX_MEDIA_PROMPT_LENGTH,
      );
    }
  });

  it("accepts a 6,531-character prompt where the model allows it", () => {
    const settings = validateMediaGenerationSettings({
      model: "openai/gpt-image-2",
      prompt: longPrompt,
      width: 1024,
      height: 1024,
    });
    expect(settings.prompt).toHaveLength(6_531);
  });

  it("refuses the same prompt with a clear error where it does not", () => {
    const attempt = () =>
      validateMediaGenerationSettings({
        model: "@cf/black-forest-labs/flux-1-schnell",
        prompt: longPrompt,
        width: 1024,
        height: 768,
      });
    expect(attempt).toThrow(MediaSettingsError);
    expect(attempt).toThrow(/6531 characters; its limit is 2048/u);
  });

  it("enforces the video provider bound through the same field", () => {
    expect(() =>
      validateMediaGenerationSettings({
        model: "bytedance/seedance-2.0",
        prompt: "a".repeat(2_001),
        width: 1280,
        height: 720,
      }),
    ).toThrow(/limit is 2000/u);
  });
});
