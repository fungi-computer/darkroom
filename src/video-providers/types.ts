import type {
  MediaAiResult,
  MediaGenerationSettings,
  MediaReferenceBytes,
} from "../index.js";
import type {
  MediaModel,
  MediaVideoAspectRatio,
  MediaVideoModel,
  MediaVideoResolution,
} from "../model-catalog.js";
import type { UnifiedGatewayInput } from "./unified.js";
import type { MinimaxGatewayInput } from "./minimax.js";

/** One verified video provider family, as the catalog names it. */
export type VideoProvider = MediaVideoModel["provider"];

/** Validated video settings with every video-only field guaranteed present;
 * `gatewayInput` narrows to this before handing settings to an adapter. */
export type CheckedVideoSettings = MediaGenerationSettings & {
  resolution: MediaVideoResolution;
  aspectRatio: MediaVideoAspectRatio;
  durationSeconds: number;
};

/** Every documented provider request body this catalog can produce. */
export type VideoProviderInput = UnifiedGatewayInput | MinimaxGatewayInput;

/**
 * One provider family's wire translation: the exact request body its
 * documented schema expects, and how to pull a validated result URL out of
 * its answer. Adding a provider means writing one adapter and one table
 * entry; `gatewayInput` and `generateThroughGateway` never branch on the
 * provider name themselves.
 */
export type VideoProviderAdapter = {
  /** Build the provider JSON body for one validated video generation. */
  buildInput(
    checked: CheckedVideoSettings,
    references: readonly MediaReferenceBytes[],
    model: MediaModel,
  ): VideoProviderInput;
  /** Extract and validate the HTTPS result URL from the raw provider answer. */
  decodeResultUrl(providerValue: MediaAiResult): string;
};
