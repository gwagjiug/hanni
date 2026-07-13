import { z } from 'zod';

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

export const archivePreparationSchema = z.object({
  category: z.object({
    name: z.string().trim().min(1).max(100),
    mode: z.enum(['existing', 'new']),
    rationale: z.string().trim().min(1).max(500),
  }),
  prTitle: z.string().trim().min(1).max(256),
  prBody: z.string().trim().min(1).max(10_000),
});

export const archiveDraftSchema = archivePreparationSchema.extend({
  runId: z.string().min(1),
  title: z.string().min(1).max(300),
  url: z.string().url(),
  pins: z.array(z.string().min(1).max(2_000)).min(1).max(10),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  pinPath: z.string().regex(/^pins\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/),
  readmeBefore: z.string(),
  readmeAfter: z.string(),
  pinContent: z.string(),
  baseCommitSha: z.string().min(1),
  baseTreeSha: z.string().min(1),
  model: z.string().min(1),
  usage: tokenUsageSchema,
  estimatedCostUsd: z.number().nonnegative(),
});

export const archiveWorkflowInputSchema = z.object({
  pins: z.array(z.string().min(1).max(2_000)).min(1).max(10),
  note: z.string().max(1_000).optional(),
});

export function parseArchiveDraft(value: string) {
  return archiveDraftSchema.parse(JSON.parse(value));
}

export function parseArchiveWorkflowInput(value: string) {
  return archiveWorkflowInputSchema.parse(JSON.parse(value));
}
