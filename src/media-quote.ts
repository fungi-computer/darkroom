import { estimate } from "./cloudflare/provider.js";
import { mediaUnits, type MediaUnits } from "./gateway-models.js";
import {
  resolveMediaReferences,
  validateMediaGenerationSettings,
  type MediaGenerationSettingsInput,
  type MediaReferenceReader,
} from "./index.js";

/** The provider cost of one exact generation request, before any billing policy. */
export type MediaQuote = Readonly<
  MediaUnits & {
    /** Provider milliunits of a cent, as admission would estimate them. */
    providerCostMilliunits: number;
  }
>;

/**
 * Quote one exact request: the same settings validation, reference reads,
 * estimator and billing units a generation uses at admission, run without
 * dispatching anything. A host applies its billing policy to this per unit,
 * the way its metering does, so the number matches the charge.
 */
export async function quoteMediaGeneration(
  raw: MediaGenerationSettingsInput,
  references: MediaReferenceReader,
): Promise<MediaQuote> {
  const settings = validateMediaGenerationSettings(raw);
  const resolved = await resolveMediaReferences(settings, references);
  return {
    ...mediaUnits(settings),
    providerCostMilliunits: estimate(settings, resolved),
  };
}
