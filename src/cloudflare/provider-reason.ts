import { z } from "zod";
import {
  type MediaProviderReason,
  mediaProviderDetailMax,
} from "@fungi.computer/agar/errors";

/**
 * Documented numeric codes, by failure class.
 * Workers AI: https://developers.cloudflare.com/workers-ai/platform/errors/
 * AI Gateway: https://developers.cloudflare.com/ai-gateway/reference/troubleshooting/
 * 2021 is also observed (receipts/prints-e2e: "AiGatewayError: 2021: Insufficient
 * AI Gateway credits"). Codes the docs do not state stay unclassified.
 */
const reasonByCode: ReadonlyMap<number, MediaProviderReason> = new Map([
  // Gateway or provider rejected the request as invalid ("7003: Model execution
  // failed (User Input Error): <REASON>"), or the body/size/base64 was unusable.
  [7003, "invalid_input"],
  [3003, "invalid_input"],
  [3006, "invalid_input"],
  [5004, "invalid_input"],
  // Request rate or Workers AI capacity.
  [2018, "rate_limited"],
  [3040, "rate_limited"],
  // Prepaid gateway balance.
  [2021, "credits_exhausted"],
  [2052, "credits_exhausted"],
  // Daily allocation used up.
  [3036, "spending_limit"],
  // Timeout.
  [3007, "timeout"],
  // Provider or gateway could not answer.
  [7005, "provider_unavailable"],
  [2002, "provider_unavailable"],
  [2005, "provider_unavailable"],
]);

// "<code>: <rest>", optionally led by the gateway's own "AiGatewayError: ".
const providerMessage = z
  .string()
  .regex(/^(?:Ai(?:Gateway)?Error: )*\d{4,5}: /u)
  .transform((message) => {
    // The regex above guarantees "<code>: " follows the optional prefixes.
    const body = message.replace(/^(?:Ai(?:Gateway)?Error: )*/u, "");
    const cut = body.indexOf(": ");
    return { code: Number(body.slice(0, cut)), rest: body.slice(cut + 2) };
  });

// Native Miniflare's local AI stub has no code field. Decode its complete
// vendor grammar here, alongside Workers AI's numeric message grammar.
const disabledRemoteBinding = z.literal("Binding AI needs to be run remotely");

// Never print keys, URLs, ids or structured bodies: plain words only.
const safeSentence = z
  .string()
  .trim()
  .min(1)
  .max(mediaProviderDetailMax)
  .regex(/^[\p{L}\p{N} .,'’:;()-]+$/u)
  .refine((text) => !/[A-Za-z0-9_-]{20,}/u.test(text))
  .refine(
    (text) => !/key|token|secret|bearer|password|authorization/iu.test(text),
  );

/** The reason a provider failure is classified under, from its documented code or wording. */
export function providerReason(
  name: string | undefined,
  message: string | undefined,
): MediaProviderReason | undefined {
  // Native Miniflare AI binding error, reproduced with Wrangler 4.159.0 and
  // dev.remote: false. This is local configuration, not a provider outage.
  if (disabledRemoteBinding.safeParse(message).success)
    return "remote_binding_disabled";
  if (name === "TimeoutError") return "timeout";
  const parsed = providerMessage.safeParse(message);
  if (!parsed.success) return undefined;
  const byCode = reasonByCode.get(parsed.data.code);
  return byCode;
}

/**
 * The provider's own short sentence, when it is plain words. For 7003 it is the
 * <REASON> after "Model execution failed (User Input Error): ".
 */
export function providerDetail(
  message: string | undefined,
): string | undefined {
  const parsed = providerMessage.safeParse(message);
  if (!parsed.success) return undefined;
  const reason =
    /^Model execution failed \(User Input Error\): ([\s\S]*)$/u.exec(
      parsed.data.rest,
    );
  const sentence = safeSentence.safeParse(
    (reason?.[1] ?? parsed.data.rest).replace(/^(?:AiError: )+/u, ""),
  );
  return sentence.success ? sentence.data : undefined;
}
