import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { isGithubPushDestination } from '../github-issue-request';
import { GithubCliNotFoundError, GithubIssueError, githubLoginToken } from './github-issue';
import type { PreparedLocalGithubPush } from './local-github-push';

const oidPattern = /^[a-f0-9]{40}$/u;
const responseLimit = 2 * 1024 * 1024;
const expectedService = '# service=git-receive-pack\n';
const advertisementType = 'application/x-git-receive-pack-advertisement';
const requestType = 'application/x-git-receive-pack-request';
const resultType = 'application/x-git-receive-pack-result';

function pack(approved: PreparedLocalGithubPush): Buffer {
  const objects = [
    ...approved.objects,
    {
      kind: 'commit' as const,
      oid: approved.commitOid,
      contentBase64: approved.commitContentBase64,
    },
  ];
  const head = Buffer.from('PACK00000000');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const chunks = [head];
  for (const object of objects) {
    const payload = Buffer.from(object.contentBase64, 'base64');
    const oid = createHash('sha1')
      .update(object.kind + ' ' + payload.length + '\0')
      .update(payload)
      .digest('hex');
    if (oid !== object.oid)
      throw new GithubIssueError('送信するGitオブジェクトのSHAを確認できませんでした。');
    const kind = object.kind === 'commit' ? 1 : object.kind === 'tree' ? 2 : 3;
    let remainder = payload.length >>> 4;
    const header = [(kind << 4) | (payload.length & 15) | (remainder ? 128 : 0)];
    while (remainder) {
      const next = remainder >>> 7;
      header.push((remainder & 127) | (next ? 128 : 0));
      remainder = next;
    }
    chunks.push(Buffer.from(header), deflateSync(payload, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function packet(text: string): Buffer {
  const contents = Buffer.from(text, 'ascii');
  return Buffer.concat([
    Buffer.from((contents.length + 4).toString(16).padStart(4, '0')),
    contents,
  ]);
}

function parsePackets(buffer: Buffer): Array<string | null> {
  const packets: Array<string | null> = [];
  for (let offset = 0; offset < buffer.length;) {
    const length = buffer.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/u.test(length)) throw new Error('Invalid packet');
    const count = Number.parseInt(length, 16);
    if (count === 0) {
      packets.push(null);
      offset += 4;
    } else {
      if (count <= 4 || count > 65520 || count + offset > buffer.length)
        throw new Error('Invalid packet length');
      packets.push(buffer.toString('latin1', offset + 4, offset + count));
      offset += count;
    }
  }
  return packets;
}

async function boundedResponse(response: Response, type: string): Promise<Buffer> {
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';')[0] !== type ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Unexpected Git response');
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(parts);
      length += next.value.byteLength;
      if (length > responseLimit) throw new Error('Response too large');
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function advertisedRef(bytes: Buffer, targetRef: string): string | undefined {
  const packets = parsePackets(bytes);
  if (packets.shift() !== expectedService || packets.shift() !== null || packets.pop() !== null)
    throw new Error('Invalid Git advertisement');
  const first = packets[0];
  if (first == null) throw new Error('Missing Git capabilities');
  const boundary = first.indexOf('\0');
  if (boundary < 0) throw new Error('Missing Git capabilities');
  const capabilities = first
    .slice(boundary + 1)
    .trimEnd()
    .split(' ');
  if (
    !capabilities.includes('report-status') ||
    capabilities.some(
      (value) => value.startsWith('object-format=') && value !== 'object-format=sha1',
    )
  )
    throw new Error('Incompatible Git service');
  packets[0] = first.slice(0, boundary);
  let result: string | undefined;
  for (const line of packets) {
    const match = line?.match(/^([a-f0-9]{40}) ([^\0\n\r]+)\n?$/u);
    if (match?.[2] !== targetRef) continue;
    if (result !== undefined) throw new Error('Ambiguous Git reference');
    result = match[1];
  }
  return result;
}

export class GithubPushResultUnknown extends Error {
  constructor(readonly url: string) {
    super(
      'GitHubへの送信後、ブランチの状態を確認できませんでした。再送する前に送信先を確認してください。',
    );
  }
}

export async function pushApprovedGithubCommit(
  input: {
    repository: string;
    branch: string;
    prepared: PreparedLocalGithubPush;
    signal: AbortSignal;
    canSend: () => boolean;
    onPostStarted: (notice: string) => void;
  },
  deps: { readToken: typeof githubLoginToken; fetch: typeof fetch } = {
    readToken: githubLoginToken,
    fetch,
  },
): Promise<string> {
  const { repository, branch, prepared, signal } = input;
  const { commitOid, commit } = prepared;
  const parent = commit.parent;
  if (
    !isGithubPushDestination(repository, branch) ||
    !oidPattern.test(parent) ||
    !oidPattern.test(commitOid) ||
    /^0{40}$/u.test(parent) ||
    /^0{40}$/u.test(commitOid) ||
    parent === commitOid
  )
    throw new GithubIssueError('送信するコミットとブランチを確認してください。');
  const requireAllowed = () => {
    signal.throwIfAborted();
    if (!input.canSend()) throw new GithubIssueError('タスクの状態や権限が変わりました。');
  };
  requireAllowed();
  const packfile = pack(prepared);
  let token: string;
  try {
    token = await deps.readToken(signal);
  } catch (error) {
    if (error instanceof GithubCliNotFoundError) throw error;
    throw new GithubIssueError(
      'GitHubのログインを確認できませんでした。GitHub CLI（gh）でログイン済みか確認してください。',
    );
  }
  const branchUrl =
    'https://github.com/' +
    repository +
    '/tree/' +
    branch.split('/').map(encodeURIComponent).join('/');
  const endpoint = 'https://github.com/' + repository + '.git';
  const headers = {
    Authorization: 'Basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
    'User-Agent': 'Sprint-Coder',
    'Cache-Control': 'no-cache',
  };
  const ref = 'refs/heads/' + branch;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const discover = async () => {
    requireAllowed();
    const response = await deps.fetch(endpoint + '/info/refs?service=git-receive-pack', {
      headers,
      method: 'GET',
      redirect: 'error',
      signal: requestSignal,
      cache: 'no-store',
    });
    return advertisedRef(await boundedResponse(response, advertisementType), ref);
  };
  requireAllowed();
  let old: string | undefined;
  try {
    const repositoryUrl = 'https://api.github.com/repos/' + repository;
    const repositoryResponse = await deps.fetch(repositoryUrl, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Sprint-Coder',
      },
      method: 'GET',
      redirect: 'error',
      signal: requestSignal,
      cache: 'no-store',
    });
    const identity: unknown = JSON.parse(
      (await boundedResponse(repositoryResponse, 'application/json')).toString(),
    );
    if (
      typeof identity !== 'object' ||
      identity === null ||
      !('full_name' in identity) ||
      typeof identity.full_name !== 'string' ||
      identity.full_name.toLowerCase() !== repository.toLowerCase()
    )
      throw new Error('Unexpected GitHub repository');
    old = await discover();
  } catch {
    throw new GithubIssueError(
      'GitHubで送信先ブランチを確認できませんでした。コミットは送信していません。',
    );
  }
  requireAllowed();
  if (old === commitOid) return branchUrl;
  if (old !== parent)
    throw new GithubIssueError(
      '送信先ブランチの先端が選んだコミットの親と一致しません。コミットは送信していません。',
    );

  // Git requires the old SHA to match while updating the ref. There is exactly one update command.
  const command = packet(parent + ' ' + commitOid + ' ' + ref + '\0report-status');
  const body = Buffer.concat([command, Buffer.from('0000'), packfile]);
  requireAllowed();
  let packets: Array<string | null>;
  try {
    input.onPostStarted(
      '送信を開始したため、ブランチが更新された可能性があります。再送する前に送信先を確認してください。\n\n[送信先](' +
        branchUrl +
        ')',
    );
    const response = await deps.fetch(endpoint + '/git-receive-pack', {
      headers: { ...headers, 'Content-Type': requestType, Accept: resultType },
      redirect: 'error',
      method: 'POST',
      signal: requestSignal,
      body: Uint8Array.from(body),
    });
    packets = parsePackets(await boundedResponse(response, resultType));
  } catch {
    throw new GithubPushResultUnknown(branchUrl);
  }
  if (
    packets.length === 3 &&
    packets[2] === null &&
    packets[0]?.startsWith('unpack ') &&
    packets[1]?.startsWith('ng ' + ref + ' ')
  )
    throw new GithubIssueError(
      'GitHubはブランチを更新しませんでした。コミットのデータは送信済みの可能性があります。送信先の変更や権限を確認してください。',
    );
  if (
    packets.length !== 3 ||
    packets[0] !== 'unpack ok\n' ||
    packets[1] !== 'ok ' + ref + '\n' ||
    packets[2] !== null
  )
    throw new GithubPushResultUnknown(branchUrl);
  try {
    if ((await discover()) === commitOid) {
      requireAllowed();
      return branchUrl;
    }
  } catch {
    // The reference-update request already ran. Do not repeat it.
  }
  throw new GithubPushResultUnknown(branchUrl);
}
