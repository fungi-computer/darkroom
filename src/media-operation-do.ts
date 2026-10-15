import { DurableObject } from "cloudflare:workers";
import {
  createWorkersAiMediaProvider,
  type MediaAiPort,
} from "./cloudflare/provider.js";
import type { MediaProvider } from "./index.js";
import {
  MediaOperationOwner,
  type MediaOperationEnvironment,
} from "./media-operation-owner.js";
export type {
  MediaOperationRequest,
  MediaOperationCoordinates,
  MediaOperationEnvironment,
} from "./media-operation-owner.js";

/** Retention storage and native background provider bindings for the operation DO. */
export type MediaOperationCloudflareEnvironment = MediaOperationEnvironment &
  Readonly<{
    /** Workers AI binding for alarm-driven generation. */
    AI?: MediaAiPort;
    /** Optional AI Gateway route for background calls. */
    AI_GATEWAY_ID?: string;
  }>;

/** Cloudflare lifecycle and RPC surface around the durable media owner. */
export class MediaOperationDO extends DurableObject<MediaOperationCloudflareEnvironment> {
  protected readonly owner: MediaOperationOwner;
  constructor(
    ctx: DurableObjectState,
    env: MediaOperationCloudflareEnvironment,
  ) {
    super(ctx, env);
    this.owner = new MediaOperationOwner(
      {
        id: { name: ctx.id.name },
        blockConcurrencyWhile: (body) => ctx.blockConcurrencyWhile(body),
        storage: {
          sql: ctx.storage.sql,
          transactionSync: (body) => ctx.storage.transactionSync(body),
          isErased: async () =>
            (await ctx.storage.get("botanical:erased")) === true,
          markErased: () => ctx.storage.put("botanical:erased", true),
          listKeys: async () => [...(await ctx.storage.list()).keys()],
          deleteAlarm: () => ctx.storage.deleteAlarm(),
          deleteAll: () => ctx.storage.deleteAll(),
          getAlarm: () => ctx.storage.getAlarm(),
          setAlarm: (timestamp) => ctx.storage.setAlarm(timestamp),
        },
      },
      env,
      () => this.mediaProvider(),
      { namespace: () => this.retainedNamespace() },
    );
  }
  /** A host may pin the namespace through its own local lifecycle facts. */
  protected retainedNamespace(): string | null {
    return null;
  }
  /** Hosts may supply their own provider for background generation. */
  protected mediaProvider(): MediaProvider | undefined {
    if (this.env.AI === undefined) return undefined;
    return createWorkersAiMediaProvider(
      this.env.AI,
      this.env.AI_GATEWAY_ID === undefined
        ? undefined
        : { gateway: { id: this.env.AI_GATEWAY_ID } },
    );
  }
  /** {@inheritDoc MediaOperationOwner.read} */
  read(
    ...input: Parameters<MediaOperationOwner["read"]>
  ): ReturnType<MediaOperationOwner["read"]> {
    return this.owner.read(...input);
  }
  /** {@inheritDoc MediaOperationOwner.preflightErasure} */
  preflightErasure(
    ...input: Parameters<MediaOperationOwner["preflightErasure"]>
  ): ReturnType<MediaOperationOwner["preflightErasure"]> {
    return this.owner.preflightErasure(...input);
  }
  /** {@inheritDoc MediaOperationOwner.erase} */
  erase(
    ...input: Parameters<MediaOperationOwner["erase"]>
  ): ReturnType<MediaOperationOwner["erase"]> {
    return this.owner.erase(...input);
  }
  /** {@inheritDoc MediaOperationOwner.readErasure} */
  readErasure(
    ...input: Parameters<MediaOperationOwner["readErasure"]>
  ): ReturnType<MediaOperationOwner["readErasure"]> {
    return this.owner.readErasure(...input);
  }
  /** {@inheritDoc MediaOperationOwner.admit} */
  admit(
    ...input: Parameters<MediaOperationOwner["admit"]>
  ): ReturnType<MediaOperationOwner["admit"]> {
    return this.owner.admit(...input);
  }
  /** {@inheritDoc MediaOperationOwner.claim} */
  claim(
    ...input: Parameters<MediaOperationOwner["claim"]>
  ): ReturnType<MediaOperationOwner["claim"]> {
    return this.owner.claim(...input);
  }
  /** {@inheritDoc MediaOperationOwner.recordEstimate} */
  recordEstimate(
    ...input: Parameters<MediaOperationOwner["recordEstimate"]>
  ): ReturnType<MediaOperationOwner["recordEstimate"]> {
    return this.owner.recordEstimate(...input);
  }
  /** {@inheritDoc MediaOperationOwner.dispatchInBackground} */
  dispatchInBackground(
    ...input: Parameters<MediaOperationOwner["dispatchInBackground"]>
  ): ReturnType<MediaOperationOwner["dispatchInBackground"]> {
    return this.owner.dispatchInBackground(...input);
  }
  /** {@inheritDoc MediaOperationOwner.alarm} */
  override alarm(
    ...input: Parameters<MediaOperationOwner["alarm"]>
  ): ReturnType<MediaOperationOwner["alarm"]> {
    return this.owner.alarm(...input);
  }
  /** {@inheritDoc MediaOperationOwner.interruptGeneration} */
  interruptGeneration(
    ...input: Parameters<MediaOperationOwner["interruptGeneration"]>
  ): ReturnType<MediaOperationOwner["interruptGeneration"]> {
    return this.owner.interruptGeneration(...input);
  }
  /** {@inheritDoc MediaOperationOwner.recordGenerated} */
  recordGenerated(
    ...input: Parameters<MediaOperationOwner["recordGenerated"]>
  ): ReturnType<MediaOperationOwner["recordGenerated"]> {
    return this.owner.recordGenerated(...input);
  }
  /** {@inheritDoc MediaOperationOwner.readGenerated} */
  readGenerated(
    ...input: Parameters<MediaOperationOwner["readGenerated"]>
  ): ReturnType<MediaOperationOwner["readGenerated"]> {
    return this.owner.readGenerated(...input);
  }
  /** {@inheritDoc MediaOperationOwner.releaseWrite} */
  releaseWrite(
    ...input: Parameters<MediaOperationOwner["releaseWrite"]>
  ): ReturnType<MediaOperationOwner["releaseWrite"]> {
    return this.owner.releaseWrite(...input);
  }
  /** {@inheritDoc MediaOperationOwner.recordWritten} */
  recordWritten(
    ...input: Parameters<MediaOperationOwner["recordWritten"]>
  ): ReturnType<MediaOperationOwner["recordWritten"]> {
    return this.owner.recordWritten(...input);
  }
  /** {@inheritDoc MediaOperationOwner.recordWrittenWithoutSettlement} */
  recordWrittenWithoutSettlement(
    ...input: Parameters<MediaOperationOwner["recordWrittenWithoutSettlement"]>
  ): ReturnType<MediaOperationOwner["recordWrittenWithoutSettlement"]> {
    return this.owner.recordWrittenWithoutSettlement(...input);
  }
  /** {@inheritDoc MediaOperationOwner.recordSucceeded} */
  recordSucceeded(
    ...input: Parameters<MediaOperationOwner["recordSucceeded"]>
  ): ReturnType<MediaOperationOwner["recordSucceeded"]> {
    return this.owner.recordSucceeded(...input);
  }
  /** {@inheritDoc MediaOperationOwner.releaseEstimate} */
  releaseEstimate(
    ...input: Parameters<MediaOperationOwner["releaseEstimate"]>
  ): ReturnType<MediaOperationOwner["releaseEstimate"]> {
    return this.owner.releaseEstimate(...input);
  }
}
