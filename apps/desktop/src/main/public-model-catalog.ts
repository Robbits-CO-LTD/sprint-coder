import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  publicModelCatalogDetailInputSchema,
  publicModelCatalogDetailSchema,
  publicModelCatalogPageSchema,
  publicModelCatalogQuerySchema,
  type PublicModelCatalogDetail,
  type PublicModelCatalogItem,
  type PublicModelCatalogPage,
  type PublicModelCatalogQuery,
  type PublicModelInstallability,
} from '@sprint-coder/contracts';
import { parse as parseYaml } from 'yaml';

export type PublicCatalogFetch = (input: string, init?: RequestInit) => Promise<Response>;

const HF_ORIGIN = 'https://huggingface.co';
const HF_MODELS_PATH = '/api/models';
const LOCALAI_GALLERY_URL =
  'https://raw.githubusercontent.com/mudler/LocalAI/master/gallery/index.yaml';
const CACHE_TTL_MS = 5 * 60_000;
const CURSOR_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CURSOR_ENTRIES = 512;

type Source = 'hugging_face' | 'localai_gallery';
type SourceCursor = Readonly<{ source: Source; continuation: string | null }>;
type SourcePage = Readonly<{
  items: readonly PublicModelCatalogItem[];
  next: string | null;
  error?: PublicModelCatalogPage['errors'][number];
}>;

type CacheEntry = Readonly<{
  body: string;
  etag: string | null;
  link: string | null;
  storedAt: number;
}>;

class ConditionalResponseCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly fetch: PublicCatalogFetch,
    private readonly now: () => number,
  ) {}

  async get(
    url: string,
  ): Promise<Readonly<{ body: string; link: string | null; staleError: unknown | null }>> {
    const cached = this.entries.get(url);
    if (cached !== undefined && this.now() - cached.storedAt < CACHE_TTL_MS)
      return { body: cached.body, link: cached.link, staleError: null };
    const headers = new Headers({ accept: 'application/json, text/yaml;q=0.9, text/plain;q=0.8' });
    if (cached?.etag !== null && cached?.etag !== undefined)
      headers.set('if-none-match', cached.etag);
    try {
      const response = await this.fetch(url, { headers, redirect: 'error' });
      if (response.status === 304 && cached !== undefined) {
        this.set(url, { ...cached, storedAt: this.now() });
        return { body: cached.body, link: cached.link, staleError: null };
      }
      if (!response.ok) throw new CatalogHttpError(response.status, response.headers);
      const body = await readBoundedText(response);
      const entry = {
        body,
        etag: response.headers.get('etag'),
        link: response.headers.get('link'),
        storedAt: this.now(),
      };
      this.set(url, entry);
      return { body, link: entry.link, staleError: null };
    } catch (error) {
      if (cached !== undefined) return { body: cached.body, link: cached.link, staleError: error };
      throw error;
    }
  }

  invalidate(url: string): void {
    this.entries.delete(url);
  }

  private set(url: string, entry: CacheEntry): void {
    this.entries.delete(url);
    this.entries.set(url, entry);
    while (this.entries.size > MAX_CACHE_ENTRIES || this.cacheBytes() > MAX_CACHE_BYTES)
      this.entries.delete(this.entries.keys().next().value as string);
  }

  private cacheBytes(): number {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += Buffer.byteLength(entry.body, 'utf8');
    return bytes;
  }
}

class CatalogHttpError extends Error {
  readonly retryAt: string | null;

  constructor(
    readonly status: number,
    headers: Headers,
  ) {
    super(`Catalog request failed with HTTP ${status}`);
    this.retryAt = retryAtFromHeaders(headers);
  }
}

class OpaqueCursorVault {
  private readonly entries = new Map<
    string,
    Readonly<{ binding: string; state: SourceCursor; expiresAt: number }>
  >();

  constructor(
    private readonly secret: Uint8Array,
    private readonly now: () => number,
    private readonly id: () => string,
  ) {}

  issue(binding: string, state: SourceCursor): string {
    this.prune();
    const nonce = this.id().replace(/[^a-zA-Z0-9_-]/gu, '');
    const signature = createHmac('sha256', this.secret)
      .update(`${binding}\0${nonce}`)
      .digest('base64url')
      .slice(0, 32);
    const token = `pc1.${nonce}.${signature}`;
    this.entries.set(token, { binding, state, expiresAt: this.now() + CURSOR_TTL_MS });
    while (this.entries.size > MAX_CURSOR_ENTRIES)
      this.entries.delete(this.entries.keys().next().value as string);
    return token;
  }

  resolve(token: string, binding: string): SourceCursor {
    this.prune();
    const entry = this.entries.get(token);
    if (entry === undefined || entry.binding !== binding) throw new Error('Invalid catalog cursor');
    return entry.state;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(token);
  }
}

export class PublicModelCatalogService {
  private readonly cache: ConditionalResponseCache;
  private readonly cursors: OpaqueCursorVault;

  constructor(
    fetch: PublicCatalogFetch,
    private readonly now: () => number = Date.now,
    cursorSecret: Uint8Array = randomBytes(32),
    cursorId: () => string = randomUUID,
  ) {
    this.cache = new ConditionalResponseCache(fetch, now);
    this.cursors = new OpaqueCursorVault(cursorSecret, now, cursorId);
  }

  async query(input: PublicModelCatalogQuery): Promise<PublicModelCatalogPage> {
    let query: PublicModelCatalogQuery;
    try {
      query = publicModelCatalogQuerySchema.parse(input);
    } catch {
      throw new Error('Invalid public catalog query');
    }
    const binding = queryBinding(query);
    let state: SourceCursor;
    try {
      state =
        query.cursor === null
          ? initialCursor(query.source)
          : this.cursors.resolve(query.cursor, binding);
    } catch {
      const source = query.source === 'localai_gallery' ? 'localai_gallery' : 'hugging_face';
      return publicModelCatalogPageSchema.parse({
        items: [],
        nextCursor: null,
        errors: [
          {
            source,
            code: 'invalid_cursor',
            message: '検索条件に対応するcursorではありません。最初から検索してください。',
            retryable: false,
            retryAt: null,
          },
        ],
      });
    }
    const items: PublicModelCatalogItem[] = [];
    const errors: PublicModelCatalogPage['errors'] = [];
    let hasMore = false;

    while (items.length < query.limit) {
      const page =
        state.source === 'hugging_face'
          ? await this.queryHuggingFace(query, state.continuation, query.limit - items.length)
          : await this.queryLocalAi(query, state.continuation, query.limit - items.length);
      items.push(...page.items);
      if (page.error !== undefined) errors.push(page.error);
      if (page.next !== null) {
        state = { source: state.source, continuation: page.next };
        hasMore = true;
        break;
      }
      if (query.source === 'all' && state.source === 'hugging_face') {
        state = { source: 'localai_gallery', continuation: null };
        if (items.length === query.limit) {
          hasMore = true;
          break;
        }
        continue;
      }
      state = { source: state.source, continuation: null };
      break;
    }

    return publicModelCatalogPageSchema.parse({
      items,
      nextCursor: hasMore ? this.cursors.issue(binding, state) : null,
      errors,
    });
  }

  async detail(input: unknown): Promise<PublicModelCatalogDetail> {
    const request = publicModelCatalogDetailInputSchema.parse(input);
    const detail =
      request.source === 'hugging_face'
        ? await this.huggingFaceDetail(request.sourceId)
        : await this.localAiDetail(request.sourceId);
    return publicModelCatalogDetailSchema.parse(detail);
  }

  private async queryHuggingFace(
    query: PublicModelCatalogQuery,
    continuation: string | null,
    limit: number,
  ): Promise<SourcePage> {
    try {
      const url = continuation === null ? huggingFaceSearchUrl(query, limit) : continuation;
      assertHuggingFaceListUrl(url);
      const response = await this.fetchJson(url);
      if (!Array.isArray(response.value)) throw new Error('Expected a Hugging Face model array');
      const items = response.value
        .map(normalizeHuggingFaceItem)
        .filter((item): item is PublicModelCatalogItem => item !== null)
        .filter((item) => matchesPurpose(item, query.purpose))
        .slice(0, limit);
      const next = response.staleError === null ? nextLink(response.link, url) : null;
      return {
        items,
        next,
        ...(response.staleError === null
          ? {}
          : { error: sourceError('hugging_face', response.staleError) }),
      };
    } catch (error) {
      return { items: [], next: null, error: sourceError('hugging_face', error) };
    }
  }

  private async queryLocalAi(
    query: PublicModelCatalogQuery,
    continuation: string | null,
    limit: number,
  ): Promise<SourcePage> {
    try {
      const response = await this.fetchText(LOCALAI_GALLERY_URL);
      let entries: readonly GalleryNormalized[];
      try {
        entries = normalizeGalleryEntries(response.value, query);
      } catch (error) {
        this.cache.invalidate(LOCALAI_GALLERY_URL);
        throw error;
      }
      const offset = continuation === null ? 0 : parseGalleryOffset(continuation);
      const page = entries.slice(offset, offset + limit);
      const next = offset + page.length < entries.length ? String(offset + page.length) : null;
      return {
        items: page.map(({ item }) => item),
        next,
        ...(response.staleError === null
          ? {}
          : { error: sourceError('localai_gallery', response.staleError) }),
      };
    } catch (error) {
      return { items: [], next: null, error: sourceError('localai_gallery', error) };
    }
  }

  private async huggingFaceDetail(sourceId: string): Promise<PublicModelCatalogDetail> {
    assertHuggingFaceRepo(sourceId);
    const summaryResponse = await this.fetchJson(
      `${HF_ORIGIN}${HF_MODELS_PATH}/${sourceId.split('/').map(encodeURIComponent).join('/')}?blobs=true`,
    );
    const value = asRecord(summaryResponse.value);
    const item = normalizeHuggingFaceItem(value);
    if (item === null) throw new Error('Invalid Hugging Face model detail');
    const siblings = arrayOfRecords(value.siblings).slice(0, 256);
    const artifacts = siblings
      .filter((file) => typeof file.rfilename === 'string')
      .map((file) => {
        const filename = boundedString(file.rfilename, 512)!;
        const lfs = asOptionalRecord(file.lfs);
        const sha256 = digestOrNull(lfs?.sha256 ?? file.blobId);
        const format = filename.toLowerCase().endsWith('.gguf')
          ? ('gguf' as const)
          : ('other' as const);
        const role = format === 'gguf' ? artifactRoleFromFilename(filename) : null;
        return {
          id: artifactId('hugging_face', sourceId, filename),
          filename,
          format,
          role: role ?? 'model',
          quantization: format === 'gguf' ? quantizationFromFilename(filename) : null,
          sizeBytes: safeByteCount(lfs?.size ?? file.size),
          sha256,
          sourceUrl:
            item.immutableRevision === null
              ? null
              : huggingFaceArtifactViewUrl(sourceId, item.immutableRevision, filename),
          installability: artifactInstallability(item, format, sha256),
        };
      });
    const cardData = asOptionalRecord(value.cardData);
    const gguf = asOptionalRecord(value.gguf);
    return {
      item: withInstallabilityFromArtifacts(item, artifacts),
      description: safeExcerpt(cardData?.description ?? cardData?.summary ?? ''),
      architecture:
        boundedString(gguf?.architecture, 128) ??
        firstString(asOptionalRecord(value.config)?.architectures),
      parameterCount: safePositiveInteger(gguf?.total),
      contextTokens:
        safePositiveInteger(gguf?.context_length) ??
        safePositiveInteger(asOptionalRecord(value.config)?.max_position_embeddings),
      toolTemplate:
        typeof gguf?.chat_template === 'string' && gguf.chat_template.trim() !== ''
          ? 'available'
          : 'unknown',
      backend: 'llama.cpp',
      variants: [],
      referenceUrls: [item.sourceUrl],
      artifacts,
    };
  }

  private async localAiDetail(sourceId: string): Promise<PublicModelCatalogDetail> {
    const response = await this.fetchText(LOCALAI_GALLERY_URL);
    let records: readonly Record<string, unknown>[];
    try {
      records = galleryRecords(response.value);
    } catch (error) {
      this.cache.invalidate(LOCALAI_GALLERY_URL);
      throw error;
    }
    const entry = records.find((candidate) => candidate.name === sourceId);
    if (entry === undefined) throw new Error('LocalAI Gallery model was not found');
    return normalizeGalleryDetail(entry);
  }

  private async fetchJson(
    url: string,
  ): Promise<Readonly<{ value: unknown; staleError: unknown | null; link: string | null }>> {
    const result = await this.cache.get(url);
    try {
      return {
        value: JSON.parse(result.body) as unknown,
        staleError: result.staleError,
        link: result.link,
      };
    } catch (error) {
      this.cache.invalidate(url);
      throw error;
    }
  }

  private async fetchText(
    url: string,
  ): Promise<Readonly<{ value: string; staleError: unknown | null }>> {
    const result = await this.cache.get(url);
    return { value: result.body, staleError: result.staleError };
  }
}

function queryBinding(query: PublicModelCatalogQuery): string {
  return JSON.stringify({ ...query, cursor: null });
}

function initialCursor(source: PublicModelCatalogQuery['source']): SourceCursor {
  return {
    source: source === 'localai_gallery' ? 'localai_gallery' : 'hugging_face',
    continuation: null,
  };
}

function huggingFaceSearchUrl(query: PublicModelCatalogQuery, limit: number): string {
  const url = new URL(HF_MODELS_PATH, HF_ORIGIN);
  if (query.text !== '') url.searchParams.set('search', query.text);
  if (query.compatibility === 'compatible') url.searchParams.set('filter', 'gguf');
  url.searchParams.set('sort', query.sort === 'updated' ? 'lastModified' : query.sort);
  url.searchParams.set('direction', query.direction === 'descending' ? '-1' : '1');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('full', 'true');
  return url.toString();
}

function assertHuggingFaceListUrl(input: string): void {
  if (input.length > 8_192) throw new Error('Hugging Face cursor URL is too long');
  const url = new URL(input);
  if (
    url.origin !== HF_ORIGIN ||
    url.pathname !== HF_MODELS_PATH ||
    url.username !== '' ||
    url.password !== ''
  )
    throw new Error('Hugging Face cursor changed the official endpoint');
  const allowed = new Set(['search', 'filter', 'sort', 'direction', 'limit', 'full', 'cursor']);
  for (const key of url.searchParams.keys())
    if (!allowed.has(key)) throw new Error('Hugging Face cursor contains an unexpected parameter');
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
    throw new Error('Catalog response exceeds the size limit');
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Catalog response exceeds the size limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function assertHuggingFaceRepo(sourceId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(sourceId))
    throw new Error('Invalid Hugging Face repository id');
}

function nextLink(header: string | null, current: string): string | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/iu.exec(part);
    if (match === null) continue;
    const next = new URL(match[1]!, current).toString();
    assertHuggingFaceListUrl(next);
    return next;
  }
  return null;
}

function normalizeHuggingFaceItem(value: unknown): PublicModelCatalogItem | null {
  const record = asOptionalRecord(value);
  const sourceId = boundedString(record?.id ?? record?.modelId, 256);
  if (record === undefined || sourceId === null || !sourceId.includes('/')) return null;
  const tags = boundedStringArray(record.tags, 32, 128);
  const gated = record.gated !== false;
  const isPrivate = record.private === true;
  const gguf = tags.some((tag) => tag.toLowerCase() === 'gguf');
  const installability: PublicModelInstallability =
    isPrivate || gated
      ? { state: 'access_restricted', reason: '非公開または利用条件付きのため閲覧のみです。' }
      : gguf
        ? { state: 'metadata_required', reason: '詳細でGGUFのサイズとSHA-256を確認してください。' }
        : { state: 'unsupported', reason: 'Managed Local v1はGGUFだけを取得できます。' };
  return {
    id: `hugging_face:${sourceId}`,
    source: 'hugging_face',
    sourceId,
    name: sourceId.split('/').at(-1)!,
    author: boundedString(record.author, 128) ?? boundedString(sourceId.split('/')[0], 128),
    sourceUrl: `${HF_ORIGIN}/${sourceId}`,
    immutableRevision: revisionOrNull(record.sha),
    gated,
    private: isPrivate,
    viewable: !isPrivate,
    installability,
    license: licenseFrom(record, tags),
    purpose: boundedString(record.pipeline_tag, 64),
    tags,
    downloads: safeNonnegativeInteger(record.downloads),
    updatedAt: timestampOrNull(record.lastModified),
  };
}

type GalleryNormalized = Readonly<{
  item: PublicModelCatalogItem;
  record: Record<string, unknown>;
}>;

function normalizeGalleryEntries(
  yaml: string,
  query: PublicModelCatalogQuery,
): readonly GalleryNormalized[] {
  const needle = query.text.toLocaleLowerCase('en-US');
  const entries = galleryRecords(yaml)
    .map((record) => normalizeGalleryItem(record))
    .filter((entry): entry is GalleryNormalized => entry !== null)
    .filter(
      ({ item }) =>
        needle === '' ||
        `${item.name} ${item.tags.join(' ')}`.toLocaleLowerCase('en-US').includes(needle),
    )
    .filter(({ item }) => matchesPurpose(item, query.purpose))
    .filter(
      ({ item }) => query.compatibility === 'all' || item.installability.state !== 'unsupported',
    );
  const sign = query.direction === 'ascending' ? 1 : -1;
  return entries.sort((left, right) => {
    if (query.sort === 'updated') {
      const compared =
        (Date.parse(left.item.updatedAt ?? '') || 0) -
        (Date.parse(right.item.updatedAt ?? '') || 0);
      if (compared !== 0) return sign * compared;
    }
    if (query.sort === 'downloads') {
      const compared = (left.item.downloads ?? 0) - (right.item.downloads ?? 0);
      if (compared !== 0) return sign * compared;
    }
    return sign * left.item.name.localeCompare(right.item.name);
  });
}

function galleryRecords(yaml: string): readonly Record<string, unknown>[] {
  const parsed = parseYaml(yaml, { merge: true }) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Invalid LocalAI Gallery index');
  return parsed
    .map(asOptionalRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
}

function normalizeGalleryItem(record: Record<string, unknown>): GalleryNormalized | null {
  const name = boundedString(record.name, 256);
  if (name === null) return null;
  const tags = boundedStringArray(record.tags, 32, 128);
  const artifacts = galleryArtifacts(record, name);
  const installability = galleryInstallability(record, artifacts);
  return {
    record,
    item: {
      id: `localai_gallery:${name}`,
      source: 'localai_gallery',
      sourceId: name,
      name,
      author: null,
      sourceUrl: 'https://models.localai.io/',
      immutableRevision: null,
      gated: false,
      private: false,
      viewable: true,
      installability,
      license: boundedString(record.license, 128),
      purpose: tags.includes('llm') ? 'text-generation' : (tags[0] ?? null),
      tags,
      downloads: null,
      updatedAt: timestampOrNull(record.last_checked),
    },
  };
}

function normalizeGalleryDetail(record: Record<string, unknown>): PublicModelCatalogDetail {
  const normalized = normalizeGalleryItem(record);
  if (normalized === null) throw new Error('Invalid LocalAI Gallery model detail');
  const overrides = asOptionalRecord(record.overrides);
  return {
    item: normalized.item,
    description: safeExcerpt(record.description),
    architecture: null,
    parameterCount: null,
    contextTokens: safePositiveInteger(overrides?.context_size),
    toolTemplate: asOptionalRecord(overrides?.template) !== undefined ? 'available' : 'unknown',
    backend: boundedString(overrides?.backend, 128),
    variants: arrayOfRecords(record.variants)
      .map((variant) => boundedString(variant.model, 256))
      .filter((variant): variant is string => variant !== null)
      .slice(0, 64),
    referenceUrls: boundedReferenceUrls(record.urls),
    artifacts: galleryArtifacts(record, normalized.item.name),
  };
}

function galleryArtifacts(record: Record<string, unknown>, name: string) {
  const backend = boundedString(asOptionalRecord(record.overrides)?.backend, 128)?.toLowerCase();
  const supportedBackend = backend === 'llama' || backend === 'llama-cpp';
  return arrayOfRecords(record.files)
    .slice(0, 256)
    .map((file, index) => {
      const filename = boundedString(file.filename, 512) ?? `artifact-${index + 1}`;
      const format = filename.toLowerCase().endsWith('.gguf')
        ? ('gguf' as const)
        : ('other' as const);
      const role = format === 'gguf' ? artifactRoleFromFilename(filename) : null;
      const sha256 = digestOrNull(file.sha256);
      const supportedUri = isSupportedGalleryArtifactUri(file.uri);
      const installability: PublicModelInstallability = !supportedBackend
        ? {
            state: 'unsupported',
            reason: 'このgallery backendはManaged Local v1では実行できません。',
          }
        : format !== 'gguf'
          ? { state: 'unsupported', reason: 'Managed Local v1はGGUFだけを取得できます。' }
          : sha256 === null
            ? { state: 'metadata_required', reason: 'SHA-256がないため取得できません。' }
            : !supportedUri
              ? {
                  state: 'unsupported',
                  reason: 'このartifactの取得元はManaged Local v1の許可対象外です。',
                }
              : { state: 'installable', reason: 'GGUFとSHA-256を確認済みです。' };
      return {
        id: artifactId('localai_gallery', name, filename),
        filename,
        format,
        role: role ?? 'model',
        quantization: format === 'gguf' ? quantizationFromFilename(filename) : null,
        sizeBytes: safeByteCount(file.size),
        sha256,
        sourceUrl: normalizedGalleryArtifactUrl(file.uri),
        installability,
      };
    });
}

function galleryInstallability(
  record: Record<string, unknown>,
  artifacts: ReturnType<typeof galleryArtifacts>,
): PublicModelInstallability {
  const backend = boundedString(asOptionalRecord(record.overrides)?.backend, 128)?.toLowerCase();
  if (backend !== 'llama' && backend !== 'llama-cpp')
    return {
      state: 'unsupported',
      reason: 'このgallery backendはManaged Local v1では実行できません。',
    };
  const models = artifacts.filter(
    (artifact) => artifact.format === 'gguf' && artifact.role === 'model',
  );
  if (models.length === 0)
    return { state: 'unsupported', reason: 'Managed Local v1で使えるGGUF artifactがありません。' };
  if (models.some((artifact) => artifact.installability.state !== 'installable'))
    return { state: 'metadata_required', reason: 'GGUFの取得元またはSHA-256を解決できません。' };
  return { state: 'installable', reason: 'Managed Local v1で解決できるGGUFです。' };
}

function artifactInstallability(
  item: PublicModelCatalogItem,
  format: 'gguf' | 'other',
  sha256: string | null,
): PublicModelInstallability {
  if (item.gated || item.private)
    return { state: 'access_restricted', reason: '非公開または利用条件付きのartifactです。' };
  if (format !== 'gguf')
    return { state: 'unsupported', reason: 'Managed Local v1はGGUFだけを取得できます。' };
  if (item.immutableRevision === null)
    return { state: 'metadata_required', reason: 'immutable revisionを取得できません。' };
  if (sha256 === null)
    return { state: 'metadata_required', reason: '強いSHA-256を取得できません。' };
  return { state: 'installable', reason: 'GGUFとSHA-256を確認済みです。' };
}

function withInstallabilityFromArtifacts(
  item: PublicModelCatalogItem,
  artifacts: readonly { role: 'model' | 'mmproj'; installability: PublicModelInstallability }[],
): PublicModelCatalogItem {
  if (item.gated || item.private) return item;
  return artifacts.some(
    ({ role, installability }) => role === 'model' && installability.state === 'installable',
  )
    ? {
        ...item,
        installability: { state: 'installable', reason: '取得可能なGGUF artifactがあります。' },
      }
    : item;
}

function matchesPurpose(
  item: PublicModelCatalogItem,
  purpose: PublicModelCatalogQuery['purpose'],
): boolean {
  if (purpose === 'all') return true;
  const values = new Set(
    [item.purpose, ...item.tags]
      .filter((value): value is string => value !== null)
      .map((value) => value.toLowerCase()),
  );
  if (purpose === 'code')
    return values.has('code') || values.has('coding') || values.has('code-generation');
  if (purpose === 'conversational') return values.has('conversational') || values.has('chat');
  return values.has('text-generation') || values.has('llm');
}

function sourceError(source: Source, error: unknown): PublicModelCatalogPage['errors'][number] {
  if (error instanceof CatalogHttpError && error.status === 429)
    return {
      source,
      code: 'rate_limited',
      message: '公開カタログの利用上限に達しました。',
      retryable: true,
      retryAt: error.retryAt,
    };
  if (error instanceof CatalogHttpError && error.status >= 500)
    return {
      source,
      code: 'source_unavailable',
      message: '公開カタログが一時的に応答していません。',
      retryable: true,
      retryAt: null,
    };
  if (error instanceof TypeError)
    return {
      source,
      code: 'offline',
      message: 'ネットワークへ接続できません。',
      retryable: true,
      retryAt: null,
    };
  return {
    source,
    code: 'invalid_response',
    message: '公開カタログの応答を読み取れませんでした。',
    retryable: false,
    retryAt: null,
  };
}

function retryAtFromHeaders(headers: Headers): string | null {
  const value = headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  const date = Number.isFinite(seconds) ? new Date(Date.now() + seconds * 1_000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseGalleryOffset(value: string): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Invalid LocalAI Gallery cursor');
  return offset;
}

function safeExcerpt(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/^\s{0,3}(?:>|#{1,6}|[-*+]\s)/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 4_000);
}

function licenseFrom(record: Record<string, unknown>, tags: readonly string[]): string | null {
  const cardLicense = boundedString(asOptionalRecord(record.cardData)?.license, 128);
  return cardLicense ?? tags.find((tag) => tag.startsWith('license:'))?.slice(8, 136) ?? null;
}

function quantizationFromFilename(filename: string): string | null {
  return (
    /(?:^|[-_.])((?:I?Q|F)[0-9][A-Z0-9_]{0,16})(?:[-_.]|\.gguf$)/iu
      .exec(filename)?.[1]
      ?.toUpperCase() ?? null
  );
}

/**
 * llama.cpp keeps multimodal projector weights in GGUF files too. Treat only the conventional
 * standalone `mmproj` filename token as a projector; arbitrary `.gguf` files remain model
 * artifacts until a catalog explicitly classifies them.
 */
function artifactRoleFromFilename(filename: string): 'model' | 'mmproj' {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? '';
  return /(?:^|[-_.])mmproj(?:[-_.]|$)/iu.test(leaf) ? 'mmproj' : 'model';
}

function isSupportedGalleryArtifactUri(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2_048) return false;
  // The shorthand names a mutable default branch. Keep it viewable, but never expose it as a
  // durable download authority until Main resolves an exact Hub commit.
  if (value.startsWith('huggingface://')) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === HF_ORIGIN &&
      url.username === '' &&
      url.password === '' &&
      /^\/[^/]+\/[^/]+\/resolve\/(?:[a-f0-9]{40}|[a-f0-9]{64})\/.+/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function normalizedGalleryArtifactUrl(value: unknown): string | null {
  if (!isSupportedGalleryArtifactUri(value) || typeof value !== 'string') return null;
  return new URL(value).toString();
}

function huggingFaceArtifactViewUrl(repo: string, revision: string, filename: string): string {
  return `${HF_ORIGIN}/${repo}/blob/${revision}/${filename.split('/').map(encodeURIComponent).join('/')}`;
}

function artifactId(source: Source, sourceId: string, filename: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['public-model-artifact-v1', source, sourceId, filename]))
    .digest('hex');
  return `${source}:${digest}`;
}

function boundedReferenceUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length > 2_048) continue;
    try {
      const url = new URL(candidate);
      if (
        url.protocol !== 'https:' ||
        url.origin !== HF_ORIGIN ||
        url.username !== '' ||
        url.password !== ''
      )
        continue;
      urls.push(url.toString());
    } catch {
      continue;
    }
  }
  return [...new Set(urls)].slice(0, 16);
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
}

function boundedStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => boundedString(item, maxLength))
        .filter((item): item is string => item !== null),
    ),
  ].slice(0, maxItems);
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = asOptionalRecord(value);
  if (record === undefined) throw new Error('Expected an object');
  return record;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map(asOptionalRecord)
        .filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return boundedString(value, 128);
  if (Array.isArray(value)) return boundedString(value[0], 128);
  return null;
}

function digestOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/iu.test(value) ? value.toLowerCase() : null;
}

function revisionOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/iu.test(value)
    ? value.toLowerCase()
    : null;
}

function safeNonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeByteCount(value: unknown): number | null {
  return safeNonnegativeInteger(value);
}

function timestampOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
