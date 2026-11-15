import worker, {
  StandaloneMedia as NativeStandaloneMedia,
} from "../examples/standalone/worker.js";
import { MediaOperationDO as NativeMediaOperationDO } from "../dist/cloudflare.js";
export default worker;

export const imageBytes = Uint8Array.from(
  globalThis.atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (character) => character.charCodeAt(0),
);

/** Inject only provider bytes and one failed destination write; SQL and R2 are native. */
export class StandaloneMedia extends NativeStandaloneMedia {
  constructor(state, env) {
    super(state, {
      ...env,
      // The Images binding is not a provider; report fixed metadata for the 1x1 GIFs the proofs store.
      IMAGES: {
        info: async () => ({ format: "image/gif", width: 1, height: 1 }),
      },
      AI: {
        run: async (_model, input) => {
          if (input.multipart !== undefined)
            await env.PROOF.put(
              "provider-input",
              await new globalThis.Response(input.multipart.body).text(),
            );
          const previous = await env.PROOF.get("provider-count");
          const count = previous === null ? 0 : Number(await previous.text());
          await env.PROOF.put("provider-count", String(count + 1));
          const output = await env.PROOF.get("provider-image");
          return output
            ? new Uint8Array(await output.arrayBuffer())
            : imageBytes.slice();
        },
      },
      OUTPUTS: {
        get: env.OUTPUTS.get.bind(env.OUTPUTS),
        put: async (key, bytes, options) => {
          if (await env.PROOF.get("fail-next-save")) {
            await env.PROOF.delete("fail-next-save");
            throw new Error("Injected destination failure");
          }
          return env.OUTPUTS.put(key, bytes, options);
        },
      },
    });
  }
}

/** Lose the acknowledgement after native R2 commits, before the owner records SQL. */
export class MediaOperationDO extends NativeMediaOperationDO {
  constructor(state, env) {
    super(state, {
      ...env,
      APP_ARTIFACTS: {
        get: env.APP_ARTIFACTS.get.bind(env.APP_ARTIFACTS),
        head: env.APP_ARTIFACTS.head.bind(env.APP_ARTIFACTS),
        put: async (key, bytes, options) => {
          const stored = await env.APP_ARTIFACTS.put(key, bytes, options);
          if (await env.PROOF.get("fail-next-output-ack")) {
            await env.PROOF.delete("fail-next-output-ack");
            throw new Error("Lost output acknowledgement before SQL receipt");
          }
          return stored;
        },
      },
    });
  }
}
