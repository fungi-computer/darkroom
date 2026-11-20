import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Darkroom's own host, so the shipped tests run from the package too.
      "cloudflare:workers": new URL(
        "test/fixtures/cloudflare-workers.fixture.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
