import * as z from "zod";
import { listMediaModels, mediaModelSchema } from "./model-catalog.js";
import { mediaResultSchema } from "./media-operation-contract.js";
import { pendingSchema } from "@fungi.computer/agar/backend-definition";
import { mediaFailureSchema } from "./browser-failure.js";

/** Bounded catalog decoded by the App media broker before host filtering. */
export const mediaModelsSchema = z
  .array(mediaModelSchema)
  .max(listMediaModels().length);

/** An absolute output path on the Computer admitted by the App host. */
export const destinationSchema = z.strictObject({
  /** Computer admitted by the host. */
  computerId: z.string().min(1).max(256),
  /** Absolute Computer output path. */
  path: z.string().startsWith("/").max(1_024),
});

/** Completed App generation output, with its admitted Computer destination. */
export const appMediaGenerationResultSchema = mediaResultSchema
  .omit({ path: true })
  .extend({
    /** Admitted Computer and absolute output path. */
    destination: destinationSchema,
  });

/** Authority refusals emitted by Media admission before a host call. */
export const appMediaAdmissionErrorSchema = z.strictObject({
  /** Existing admission refusal code. */
  error: z.enum({
    /** The captured App selection or attachment changed. */
    revoked: "revoked",
    /** The caller does not hold this Media grant. */
    not_granted: "not_granted",
    /** The attachment's grantor no longer holds authority. */
    grantor_lost_authority: "grantor_lost_authority",
    /** Admission could not resolve the current resource. */
    unavailable: "unavailable",
  }),
});

/** Attachment budget refusal emitted by the Media reservation owner. */
export const appMediaBudgetRefusalSchema = z.strictObject({
  /** The attachment's operation budget refused this request. */
  error: z.literal("attachment_budget_exceeded"),
  /** Media reservations use the Media budget, not exec or write. */
  kind: z.literal("media"),
  /** Delay emitted by the reservation owner. */
  retryAfterMs: z.number(),
});

/** Existing Media admission refusals, without an admitted selector or callable. */
export const appMediaAdmissionRefusalSchema = z.union([
  appMediaAdmissionErrorSchema,
  appMediaBudgetRefusalSchema,
]);

/** Admission errors plus invalid/oversized inputs emitted directly by the broker. */
export const appMediaBrokerErrorSchema = appMediaAdmissionErrorSchema.extend({
  /** Existing broker refusal code. */
  error: z.enum({
    ...appMediaAdmissionErrorSchema.shape.error.enum,
    /** The broker refused the input representation or selection. */
    invalid: "invalid",
    /** The input exceeds the existing broker byte ceiling. */
    too_large: "too_large",
  }),
});

/** Missing-library refusal decoded and returned by the App media broker. */
export const agentAppMediaLibraryFailureSchema = z.strictObject({
  /** The calling Installation's library is unavailable. */
  error: z.literal("library_unavailable"),
  /** Existing library-owner presentation copy. */
  message: z.string().max(4096),
});

/** Broker projection of an HTTP failure: code becomes error and error becomes message. */
export const appMediaBrokerFailureSchema = z.strictObject({
  /** Original typed HTTP failure code. */
  error: mediaFailureSchema.shape.code,
  /** Original HTTP failure presentation copy. */
  message: mediaFailureSchema.shape.error,
  /** Original failure stage. */
  stage: mediaFailureSchema.shape.stage,
  /** Original retry truth. */
  retryable: mediaFailureSchema.shape.retryable,
});

/** Refusal payloads emitted by the App media broker, separate from transport errors. */
export const appMediaRefusalSchema = z.union([
  appMediaBrokerErrorSchema,
  appMediaBudgetRefusalSchema,
  agentAppMediaLibraryFailureSchema,
  appMediaBrokerFailureSchema,
]);

/** Model-list payload or an existing broker refusal. */
export const appMediaModelsOutcomeSchema = z.union([
  mediaModelsSchema,
  appMediaRefusalSchema,
]);

/** Completed generation, Agar polling result, or an existing broker refusal. */
export const appMediaGenerationOutcomeSchema = z.union([
  appMediaGenerationResultSchema,
  pendingSchema,
  appMediaRefusalSchema,
]);
