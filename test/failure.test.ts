import { inspect } from "node:util";
import * as Redacted from "effect/Redacted";
import { afterEach, expect, it, vi } from "vitest";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";
import { validateMediaGenerationSettings } from "../src/index.js";
import { reportCatchFailure } from "../src/failure.js";

afterEach(() => vi.restoreAllMocks());

const marker = "synthetic-private-cause-marker";
const nested = new Error(`Nested I/O failure ${marker}`);
const failure = new Error(`Operation failed ${marker}`, { cause: nested });

it.each([failure, marker])(
  "Media service reporter retains the redacted caught value (case %#)",
  (cause) => {
    const report = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    reportCatchFailure("fixture.read", cause);
    expect(report).toHaveBeenCalledOnce();
    const retained = report.mock.calls
      .flatMap((args: unknown[]) => args)
      .filter(Redacted.isRedacted)
      .map(Redacted.value);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toBe(cause);
    if (retained[0] instanceof Error) {
      expect(retained[0].cause).toBe(nested);
      expect(retained[0].stack).toBe(failure.stack);
    }
    expect(JSON.stringify(report.mock.calls)).toContain("fixture.read");
    expect(JSON.stringify(report.mock.calls)).not.toContain(marker);
    expect(inspect(report.mock.calls, { depth: null })).not.toContain(marker);
    expect(
      report.mock.calls
        .flatMap((args: unknown[]) => args)
        .map(String)
        .join(" "),
    ).not.toContain(marker);
  },
);

it.each(["@cf/black-forest-labs/flux-1-schnell", "openai/gpt-image-2"])(
  "provider reporter retains its original failure for %s",
  async (model) => {
    const report = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const run = vi.fn<MediaAiPort["run"]>().mockRejectedValue(failure);
    const settings = validateMediaGenerationSettings({
      model,
      prompt: "fixture",
      width: 1024,
      height: 1024,
    });
    await expect(generate({ run }, settings, [])).rejects.toMatchObject({
      name: "MediaExecutionError",
      stage: "provider",
      cause: failure,
    });
    const retained = report.mock.calls
      .flatMap((args: unknown[]) => args)
      .filter(Redacted.isRedacted)
      .map(Redacted.value);
    expect(retained).toEqual([failure]);
    expect(retained[0]).toBe(failure);
    expect(JSON.stringify(report.mock.calls)).toContain(
      "Media provider request failed",
    );
    expect(inspect(report.mock.calls, { depth: null })).not.toContain(marker);
    expect(JSON.stringify(report.mock.calls)).not.toContain(marker);
  },
);

it("keeps an ordinary 8007 failure opaque instead of treating its number as a safety verdict", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const cause = new Error(`8007: AiError: upstream unavailable ${marker}`);
  const run = vi.fn<MediaAiPort["run"]>().mockRejectedValue(cause);
  const settings = validateMediaGenerationSettings({
    model: "@cf/black-forest-labs/flux-1-schnell",
    prompt: "fixture",
    width: 1024,
    height: 768,
  });
  await expect(generate({ run }, settings, [])).rejects.toMatchObject({
    name: "MediaExecutionError",
    stage: "provider",
    cause,
  });
  expect(JSON.stringify(report.mock.calls)).toContain('"providerCode":8007');
  expect(inspect(report.mock.calls, { depth: null })).not.toContain(marker);
});
