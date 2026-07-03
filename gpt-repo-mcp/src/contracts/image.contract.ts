import { z } from "zod";
import { RepoInputSchema } from "./repo.contract.js";

export const FetchImageInputSchema = RepoInputSchema.extend({
  path: z.string().min(1).describe("Repo-relative POSIX path to a PNG, JPEG, or WebP image."),
  max_bytes: z.number().int().positive().optional().describe("Maximum image bytes to return. The server enforces a 5 MiB hard limit."),
  override_default_excludes: z.boolean().optional().describe("Read a default-excluded image path when repository read policy allows the override.")
});

export const ImageContentSchema = z.object({
  path: z.string(),
  mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  warnings: z.array(z.string()).default([])
});

export type FetchImageInput = z.infer<typeof FetchImageInputSchema>;
export type ImageContent = z.infer<typeof ImageContentSchema>;
