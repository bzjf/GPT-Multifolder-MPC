export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true
} as const;

export const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
  idempotentHint: false
} as const;
