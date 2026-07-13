import { estimateCost } from '../../agent/budget';
import type { ArchiveDraft } from '../../types';
import type { ArchiveSnapshot } from '../../tools/github/client';
import type { PrepareResult } from '../../tools/openai';
import type { WebMetadata } from '../../tools/web/metadata';
import {
  archiveEntry,
  insertReadmeEntry,
  renderPinFile,
  shortHash,
  slugify,
} from './render';

export async function createArchiveDraft(input: {
  runId: string;
  pins: string[];
  model: string;
  archive: ArchiveSnapshot;
  document: WebMetadata;
  llm: PrepareResult;
}): Promise<ArchiveDraft> {
  if (!input.document.title) {
    throw new Error('metadata_title_missing');
  }
  const title = input.document.title;
  let slug = slugify(title);
  if (input.archive.files.has(`pins/${slug}.md`)) {
    slug = `${slug}-${await shortHash(input.document.canonicalUrl)}`;
  }
  const pinPath = `pins/${slug}.md`;
  return {
    runId: input.runId,
    title,
    url: input.document.canonicalUrl,
    pins: input.pins,
    slug,
    pinPath,
    pinContent: renderPinFile(title, input.document.canonicalUrl, input.pins),
    readmeBefore: input.archive.readme,
    readmeAfter: insertReadmeEntry(
      input.archive.readme,
      input.llm.preparation.category.name,
      archiveEntry(title, input.document.canonicalUrl, slug),
    ),
    baseCommitSha: input.archive.baseCommitSha,
    baseTreeSha: input.archive.baseTreeSha,
    model: input.model,
    usage: input.llm.usage,
    estimatedCostUsd: estimateCost(input.llm.usage),
    ...input.llm.preparation,
  };
}
