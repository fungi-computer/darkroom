import { afterEach, expect, it, vi } from "vitest";
import { generate, type MediaAiPort } from "../src/cloudflare/provider.js";
import { MediaExecutionError } from "../src/execution-error.js";
import { validateMediaGenerationSettings } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

const settings = validateMediaGenerationSettings({
  model: "bytedance/seedance-2.0-mini",
  prompt: "a mushroom knight waves",
  width: 854,
  height: 480,
  durationSeconds: 4,
});

function failed(name: string, message: string) {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const error = new Error(message);
  error.name = name;
  const run = vi.fn<MediaAiPort["run"]>().mockRejectedValue(error);
  return generate({ run }, settings, []).then(
    () => {
      throw new Error("expected a provider failure");
    },
    (cause: unknown) => {
      if (!(cause instanceof MediaExecutionError)) throw cause;
      return cause;
    },
  );
}

// Messages are the documented wording:
// https://developers.cloudflare.com/workers-ai/platform/errors/
// https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/
it.each([
  [
    "Error",
    "Binding AI needs to be run remotely",
    { code: null, reason: "remote_binding_disabled" },
  ],
  [
    "AiGatewayError",
    "7003: Model execution failed (User Input Error): image dimensions are too small",
    {
      code: 7003,
      reason: "invalid_input",
      detail: "image dimensions are too small",
    },
  ],
  [
    "AiGatewayError",
    "7003: User Input Error",
    { code: 7003, reason: "invalid_input", detail: "User Input Error" },
  ],
  [
    "Error",
    "3006: Request is too large",
    { code: 3006, reason: "invalid_input" },
  ],
  [
    "Error",
    "3040: Capacity temporarily exceeded, please try again.",
    { code: 3040, reason: "rate_limited" },
  ],
  [
    "AiGatewayError",
    "2018: Unified billing rate limit exceeded for this gateway. Please reduce request rate or use BYOK.",
    { code: 2018, reason: "rate_limited" },
  ],
  ["Error", "3007: Request timeout", { code: 3007, reason: "timeout" }],
  [
    "TimeoutError",
    "The operation timed out",
    { code: null, reason: "timeout" },
  ],
  [
    "Error",
    "3036: You have used up your daily free allocation of 10,000 neurons.",
    { code: 3036, reason: "spending_limit" },
  ],
  [
    "AiGatewayError",
    "2052: Insufficient unified billing balance for this request. Your available balance is $0.01.",
    { code: 2052, reason: "credits_exhausted" },
  ],
  [
    "AiGatewayError",
    "2021: Insufficient AI Gateway credits",
    { code: 2021, reason: "credits_exhausted" },
  ],
  [
    "AiGatewayError",
    "7005: Unified billing is temporarily unavailable for this provider; retry, or configure your own provider API key (BYOK).",
    { code: 7005, reason: "provider_unavailable" },
  ],
  [
    "AiGatewayError",
    "2002: Model execution failed (Error)",
    { code: 2002, reason: "provider_unavailable" },
  ],
  [
    "AiGatewayError",
    "2005: Failed to get response from provider",
    { code: 2005, reason: "provider_unavailable" },
  ],
  [
    "Error",
    "3030: AiError: AiError: Your output has been flagged. Please choose another prompt / input image combination (5dbf4c51-d344-437d-b202-7bdd4310a043)",
    { code: 3030, reason: "content_refused" },
  ],
  [
    "AiGatewayError",
    "7003: Model execution failed (User Input Error): The input image may violate our policies, so it might violate our policies",
    { code: 7003, reason: "content_refused" },
  ],
] as const)("classifies %s %j", async (name, message, expected) => {
  const cause = await failed(name, message);
  expect(cause).toMatchObject({ stage: "provider", provider: expected });
});

it("keeps a short plain provider sentence for an unclassified error", async () => {
  const cause = await failed("Error", "3999: The frame rate is not supported");
  expect(cause).toMatchObject({
    provider: { code: 3999, detail: "The frame rate is not supported" },
  });
});

it.each([
  `3999: {"error":{"message":"bad"}}`,
  "3999: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  "3999: key sk-live-abcdefghijklmnopqrstuvwxyz",
  `3999: ${"x".repeat(200)}`,
  "3999: see https://example.com/a",
])("never keeps unsafe provider text %#", async (message) => {
  const cause = await failed("Error", message);
  expect(cause).toMatchObject({ provider: { code: 3999 } });
  expect(JSON.stringify(cause.provider)).not.toContain("detail");
});
