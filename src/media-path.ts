import * as z from "zod";

/** A fixed destination or reference path: an R2 object key or a file path, never a URL. */
export const mediaPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((path) => !path.includes("\0"));
