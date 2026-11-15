import { DurableObject } from "cloudflare:workers";
import { Hono, type MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import {
  createMediaService,
  mediaRequestSchema,
} from "@fungi.computer/darkroom/server";
import {
  createImagesReferenceFitter,
  createR2MediaDestination,
  createWorkersAiMediaProvider,
  MediaOperationDO,
  type MediaImagePort,
} from "@fungi.computer/darkroom/cloudflare";

export { MediaOperationDO };

export type StandaloneMediaEnv = {
  MEDIA_TOKEN: string;
  MEDIA_HOST: DurableObjectNamespace<StandaloneMedia>;
  MEDIA_OPERATION: DurableObjectNamespace<MediaOperationDO>;
  APP_ARTIFACTS: R2Bucket;
  OUTPUTS: R2Bucket;
  AI: Ai;
  IMAGES: MediaImagePort;
};

/** One authenticated application; each request ID retains its own operation DO. */
export class StandaloneMedia extends DurableObject<StandaloneMediaEnv> {
  override fetch(request: Request): Promise<Response> {
    const app = createMediaService({
      scope: {
        actorId: "api-token",
        namespace: "standalone",
        owner: "media",
        destinationId: "outputs",
      },
      operations: this.env.MEDIA_OPERATION,
      provider: createWorkersAiMediaProvider(this.env.AI),
      // This single-tenant host pays its own Workers AI account; nothing to bill.
      metering: "unmetered",
      // Reference images are read from, and outputs written to, the OUTPUTS bucket.
      // Pass `authorize(key)` to apply your own permission check to every key.
      destination: createR2MediaDestination({
        bucket: this.env.OUTPUTS,
        destinationId: "outputs",
        fit: createImagesReferenceFitter(this.env.IMAGES),
      }),
    });
    app.get("/object", async (context) => {
      const key = mediaRequestSchema.shape.path.safeParse(
        context.req.query("key"),
      );
      if (!key.success)
        return context.json({ error: "Invalid object key" }, 400);
      const object = await this.env.OUTPUTS.get(key.data);
      if (object === null) return context.notFound();
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
    return Promise.resolve(app.fetch(request));
  }
}

const app = new Hono<{ Bindings: StandaloneMediaEnv }>();
const authenticate: MiddlewareHandler<{
  Bindings: StandaloneMediaEnv;
}> = async (context, next) => {
  if (!context.env.MEDIA_TOKEN)
    return context.json(
      { error: "Configure MEDIA_TOKEN before using this host" },
      503,
    );
  return bearerAuth<{ Bindings: StandaloneMediaEnv }>({
    token: context.env.MEDIA_TOKEN,
  })(context, next);
};
app.use("*", authenticate);
app.all("*", (context) =>
  context.env.MEDIA_HOST.getByName("media").fetch(context.req.raw),
);
export default app;
