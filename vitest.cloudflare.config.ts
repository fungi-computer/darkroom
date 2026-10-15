import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest({
      main: "./test/standalone.worker.mjs",
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-09-02",
        bindings: { MEDIA_TOKEN: "local-media-proof" },
        durableObjects: {
          MEDIA_HOST: { className: "StandaloneMedia", useSQLite: true },
          MEDIA_OPERATION: { className: "MediaOperationDO", useSQLite: true },
        },
        r2Buckets: ["APP_ARTIFACTS", "OUTPUTS", "PROOF"],
      },
    }),
  ],
  test: { include: ["test/standalone.cloudflare.test.mjs"] },
});
