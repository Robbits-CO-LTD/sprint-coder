import { createHash, randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
import {
  graphSourceRefSchema,
  type GraphSourceRef,
  type GraphSourceRequest,
  type GraphDocument,
} from '@sprint-coder/contracts';
import type { ToolExecutionContext } from '@sprint-coder/domain';
import type { RevisionBoundFile } from './file-revision';
import type { PathGuard } from './path-guard';

type Receipt = {
  context: ToolExecutionContext;
  workspaceDigest: string;
  guard: PathGuard;
  observed: RevisionBoundFile;
  disclosed: string;
  returned: string;
  range: { unit: 'line' | 'byte'; start: number; end: number };
  observedAt: string;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only successful, permission/disclosure-checked read_file execution records receipts here. */
export class GraphReadReceipts {
  private readonly receipts = new Map<string, Receipt>();
  record(value: Receipt): void {
    this.receipts.set(
      value.observed.token.id,
      Object.freeze({
        ...value,
        context: Object.freeze({ ...value.context }),
        range: Object.freeze({ ...value.range }),
      }),
    );
    let bytes = [...this.receipts.values()].reduce(
      (total, entry) =>
        total +
        entry.observed.token.size +
        Buffer.byteLength(entry.disclosed) +
        Buffer.byteLength(entry.returned),
      0,
    );
    while (this.receipts.size > 128 || bytes > 32 * 1024 * 1024) {
      const first = this.receipts.entries().next().value;
      if (!first) break;
      bytes -=
        first[1].observed.token.size +
        Buffer.byteLength(first[1].disclosed) +
        Buffer.byteLength(first[1].returned);
      this.receipts.delete(first[0]);
    }
  }
  finishTurn(taskId: string, turnId: string): void {
    for (const [id, receipt] of this.receipts)
      if (receipt.context.taskId === taskId && receipt.context.turnId === turnId)
        this.receipts.delete(id);
  }
  resolve(
    requests: readonly GraphSourceRequest[],
    context: ToolExecutionContext,
    workspaceDigest: string | null,
  ): GraphSourceRef[] {
    return requests
      .filter((request) => request.kind === 'read')
      .map((request) => {
        const receipt = this.receipts.get(request.tokenId);
        if (
          !receipt ||
          receipt.context.taskId !== context.taskId ||
          receipt.context.turnId !== context.turnId ||
          receipt.context.policyEpoch !== context.policyEpoch ||
          receipt.workspaceDigest !== workspaceDigest
        )
          throw new Error(
            'Source read is unavailable for this Task, Turn or Workspace; read the file again',
          );
        const rawLines = receipt.observed.content.split('\n');
        const disclosedLines = receipt.disclosed.split('\n');
        if (
          request.lineStart > request.lineEnd ||
          request.lineEnd > rawLines.length ||
          request.lineEnd - request.lineStart >= 200
        )
          throw new Error('Source line range is invalid or exceeds 200 lines');
        const excerpt = rawLines.slice(request.lineStart - 1, request.lineEnd).join('\n');
        // Redaction can remove lines. Accept only an unchanged prefix or a line-preserving
        // disclosure whose selected lines match; never map a shifted redacted range by guesswork.
        const prefixMatches =
          rawLines.slice(0, request.lineEnd).join('\n') ===
          disclosedLines.slice(0, request.lineEnd).join('\n');
        if (
          (!prefixMatches && rawLines.length !== disclosedLines.length) ||
          excerpt !== disclosedLines.slice(request.lineStart - 1, request.lineEnd).join('\n') ||
          Buffer.byteLength(excerpt) > 16 * 1024
        )
          throw new Error('Source range does not match disclosed code');
        if (receipt.range.unit === 'line') {
          const offset = request.lineStart - receipt.range.start;
          const returnedLines = receipt.returned.split('\n');
          if (
            offset < 0 ||
            request.lineEnd > receipt.range.end ||
            offset + request.lineEnd - request.lineStart >= returnedLines.length ||
            returnedLines
              .slice(offset, offset + request.lineEnd - request.lineStart + 1)
              .join('\n') !== excerpt
          )
            throw new Error('Source range was not included in the delivered read');
        } else {
          const sourceBytes = Buffer.from(receipt.disclosed);
          const start =
            Buffer.byteLength(disclosedLines.slice(0, request.lineStart - 1).join('\n')) +
            (request.lineStart > 1 ? 1 : 0);
          const end = start + Buffer.byteLength(excerpt);
          if (
            start < receipt.range.start ||
            end > receipt.range.end ||
            !Buffer.from(receipt.returned).equals(
              sourceBytes.subarray(receipt.range.start, receipt.range.end),
            )
          )
            throw new Error('Source range was not included in the delivered read');
        }
        const path = relative(receipt.guard.workspacePath, receipt.guard.resolvedPath)
          .split(sep)
          .join('/');
        return graphSourceRefSchema.parse({
          id: randomUUID(),
          elementKind: request.elementKind,
          elementId: request.elementId,
          rootId: receipt.guard.rootId,
          rootIdentityDigest: receipt.guard.rootIdentityDigest,
          path,
          lineStart: request.lineStart,
          lineEnd: request.lineEnd,
          contentHash: receipt.observed.token.contentHash,
          excerptHash: hash(excerpt),
          excerpt,
          observedAt: receipt.observedAt,
        });
      });
  }
}

export function bindGraphSources(
  requests: readonly GraphSourceRequest[],
  observed: readonly GraphSourceRef[],
  prior: GraphDocument | null,
): GraphSourceRef[] {
  let readIndex = 0;
  const sources = requests.map((request) => {
    if (request.kind === 'saved') {
      const saved = prior?.sources.find((source) => source.id === request.sourceId);
      if (!saved) throw new Error('Saved source reference is not in the current graph');
      return saved;
    }
    const source = observed[readIndex++];
    if (!source) throw new Error('Source observation is missing');
    const previous = prior?.sources.find((entry) => sourceLocator(entry) === sourceLocator(source));
    return previous ? { ...source, id: previous.id } : source;
  });
  if (readIndex !== observed.length || new Set(sources.map(sourceLocator)).size !== sources.length)
    throw new Error('Source references contain duplicate or unexpected observations');
  return sources;
}

function sourceLocator(source: GraphSourceRef): string {
  return JSON.stringify([
    source.elementKind,
    source.elementId,
    source.rootId,
    source.rootIdentityDigest,
    source.path,
    source.lineStart,
    source.lineEnd,
  ]);
}

/** File bytes/hashes stay local; another Provider must use read_file with its own disclosure check. */
export function graphDocumentForModel(document: GraphDocument | null): unknown {
  return document === null
    ? null
    : {
        id: document.id,
        taskId: document.taskId,
        kind: document.kind,
        title: document.title,
        semanticRevision: document.semanticRevision,
        renderRevision: document.renderRevision,
        diagram: document.diagram,
        annotations: document.annotations,
        missionPlan: document.missionPlan,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        sources: document.sources.map(
          ({ id, elementKind, elementId, rootId, path, lineStart, lineEnd, observedAt }) => ({
            id,
            elementKind,
            elementId,
            rootId,
            path,
            lineStart,
            lineEnd,
            observedAt,
            snapshot: 'observed-at-read',
          }),
        ),
      };
}
