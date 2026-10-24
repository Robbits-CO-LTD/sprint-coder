const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
export const MAX_MERGE_BATCH_CANDIDATES = 4_096;

export type GitCommitMetadata = Readonly<{
  head: string;
  firstParent: string | null;
  tree: string;
}>;

/** Only object identities are requested from rev-list, never commit text or signature output. */
export function parseGitCommitMetadata(output: string): GitCommitMetadata[] | null {
  if (output === '') return [];
  const lines = output.split('\n');
  if (lines.pop() !== '' || lines.length > MAX_MERGE_BATCH_CANDIDATES) return null;
  const result: GitCommitMetadata[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const fields = line.split('\0');
    const [head, parentField, tree] = fields;
    if (
      fields.length !== 3 ||
      head === undefined ||
      tree === undefined ||
      parentField === undefined ||
      !OID.test(head) ||
      !OID.test(tree) ||
      seen.has(head)
    )
      return null;
    const parents = parentField === '' ? [] : parentField.split(' ');
    if (parents.some((parent) => !OID.test(parent))) return null;
    seen.add(head);
    result.push({ head, firstParent: parents[0] ?? null, tree });
  }
  return result;
}

/** --stdin has per-record 1=clean / 0=conflict, independently of its process exit code. */
export function parseGitMergeTrees(output: string, count: number): Array<string | null> | null {
  const fields = output.split('\0');
  const result: Array<string | null> = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const status = fields[cursor++];
    const tree = fields[cursor++];
    if ((status !== '0' && status !== '1') || tree === undefined || !OID.test(tree)) return null;
    if (status === '1' && fields[cursor] !== '') return null;
    // Conflict paths can themselves contain newlines. Only the NUL terminator ends a record.
    while (cursor < fields.length && fields[cursor] !== '') cursor += 1;
    if (cursor >= fields.length - 1) return null;
    cursor += 1;
    result.push(status === '1' ? tree : null);
  }
  return cursor === fields.length - 1 && fields[cursor] === '' ? result : null;
}
