import { inspect } from "node:util";
import * as Redacted from "effect/Redacted";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
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

it("recognizes the captured Flux output rejection without treating 3030 as transient", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  // Exact upstream message observed in the retained Prints request's REST
  // replay, 2026-10-29. Workers AI prefixes binding errors with the code.
  const cause = new Error(
    "3030: AiError: AiError: Your output has been flagged. Please choose another prompt / input image combination (5dbf4c51-d344-437d-b202-7bdd4310a043)",
  );
  const run = vi.fn<MediaAiPort["run"]>().mockRejectedValue(cause);
  const settings = validateMediaGenerationSettings({
    model: "@cf/black-forest-labs/flux-2-klein-4b",
    prompt: "This little guy dunking a baskettball",
    width: 1280,
    height: 720,
  });
  await expect(generate({ run }, settings, [])).rejects.toMatchObject({
    name: "MediaSafetyFilterRefusal",
    stage: "provider",
    cause,
    provider: { code: 3030 },
  });
  expect(run).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(
    "Media provider request failed",
    expect.objectContaining({
      model: settings.model,
      providerCode: 3030,
      category: "Error",
      providerMessage: cause.message,
    }),
    expect.anything(),
  );
});

it("retries documented capacity exhaustion once with a fresh multipart stream, then stops", async () => {
  // https://developers.cloudflare.com/workers-ai/platform/errors/
  // 3040: "Capacity temporarily exceeded, please try again."
  const diagnostic = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const bodies: FormData[] = [];
  const multipart = z.object({
    multipart: z.object({
      body: z.instanceof(ReadableStream),
      contentType: z.string(),
    }),
  });
  const run = vi.fn<MediaAiPort["run"]>(async (_model, input) => {
    const checked = multipart.parse(input).multipart;
    bodies.push(
      await new Response(checked.body, {
        headers: { "Content-Type": checked.contentType },
      }).formData(),
    );
    throw new Error("3040: Capacity temporarily exceeded, please try again.");
  });
  const settings = validateMediaGenerationSettings({
    model: "@cf/black-forest-labs/flux-2-klein-4b",
    prompt: "a mushroom on a basketball court",
    width: 1024,
    height: 768,
  });
  await expect(generate({ run }, settings, [])).rejects.toMatchObject({
    stage: "provider",
    provider: { code: 3040 },
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body.get("prompt")).toBe("a mushroom on a basketball court");
    expect(body.get("width")).toBe("1024");
    expect(body.get("height")).toBe("768");
  }
});

it.each([3030, 3043, 3007, 3008])(
  "does not infer automatic retry permission from provider code %i",
  async (code) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = vi
      .fn<MediaAiPort["run"]>()
      .mockRejectedValue(new Error(`${String(code)}: upstream details`));
    const settings = validateMediaGenerationSettings({
      model: "@cf/black-forest-labs/flux-2-klein-4b",
      prompt: "a mushroom on a basketball court",
      width: 1024,
      height: 768,
    });
    await expect(generate({ run }, settings, [])).rejects.toMatchObject({
      name: "MediaExecutionError",
      provider: { code },
    });
    expect(run).toHaveBeenCalledOnce();
  },
);
