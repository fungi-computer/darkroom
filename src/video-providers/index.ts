import { unifiedVideoAdapter } from "./unified.js";
import { minimaxVideoAdapter } from "./minimax.js";
import type { VideoProvider, VideoProviderAdapter } from "./types.js";

export type { CheckedVideoSettings } from "./types.js";

/**
 * One adapter per verified video provider family. Seedance and Veo share
 * `unifiedVideoAdapter`; MiniMax's distinct `content[]` request and
 * `{task: {...}}` answer get their own module. Adding a provider means
 * writing one adapter module and one entry here — `gatewayInput` and
 * `generateThroughGateway` never branch on the provider name themselves.
 */
export const videoProviderAdapters = {
  seedance: unifiedVideoAdapter,
  veo: unifiedVideoAdapter,
  minimax: minimaxVideoAdapter,
} satisfies Record<VideoProvider, VideoProviderAdapter>;
