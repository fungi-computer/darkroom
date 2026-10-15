import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "../shiitake/test/fixtures/cloudflare-workers.fixture.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
