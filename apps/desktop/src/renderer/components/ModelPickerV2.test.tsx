import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { modelCatalogQueryInputSchema, type ProviderModel } from '@sprint-coder/contracts';
import {
  AccessTypeToggle,
  DEFAULT_ACCESS_TYPE,
  MODEL_ACCESS_OPTIONS,
  catalogQuery,
  connectionLabel,
  describeModel,
  groupAtScrollTop,
  modelGroup,
  startsGroup,
} from './ModelPickerV2';

// The unified AI picker (UI slice U1b follow-up): one control for connection *and* model, with the
// API / サブスク toggle deciding which half of the catalog is on screen. What is covered here is
// everything the picker decides on its own — the query it sends, and how a row names its connection.
// Both are pure, and both are places where a shortcut ("assume subscription", "special-case the
// built-in ids") would reintroduce exactly the Runtime coupling this slice removes.

const unknown = { value: null, source: 'unknown' as const };

function model(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    connectionId: 'builtin:claude-cli',
    connectionDisplayName: 'Claude Code',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    available: true,
    availabilityCheckedAt: '2026-07-29T00:00:00.000Z',
    contextWindow: unknown,
    maxOutputTokens: unknown,
    toolCalling: unknown,
    structuredOutput: unknown,
    multimodalInput: unknown,
    reasoning: unknown,
    ...overrides,
  };
}

describe('MODEL_ACCESS_OPTIONS', () => {
  it('offers exactly the two access types the catalog contract defines', () => {
    // The labels are the user's words; the ids are the contract's. Mapping one to the other here is
    // the only place the two vocabularies meet.
    expect(MODEL_ACCESS_OPTIONS.map(({ id, label }) => [label, id])).toEqual([
      ['API', 'api'],
      ['サブスク', 'subscription'],
    ]);
  });

  it('defaults to the access that needs no configuration', () => {
    expect(DEFAULT_ACCESS_TYPE).toBe('subscription');
    expect(MODEL_ACCESS_OPTIONS.some(({ id }) => id === DEFAULT_ACCESS_TYPE)).toBe(true);
  });
});

describe('catalogQuery', () => {
  it('asks Main for one access type at a time', () => {
    expect(
      catalogQuery({ taskId: 'task-a', text: '', accessType: 'subscription', cursor: null })
        .accessTypes,
    ).toEqual(['subscription']);
    expect(
      catalogQuery({ taskId: 'task-a', text: '', accessType: 'api', cursor: null }).accessTypes,
    ).toEqual(['api']);
  });

  it('carries the search and the cursor unchanged, and narrows nothing else', () => {
    // Search, ordering and paging are Main's; the picker adds no local filter on top of them, so
    // every other narrowing field stays empty on purpose.
    const query = catalogQuery({
      taskId: 'task-a',
      text: 'sonnet',
      accessType: 'api',
      cursor: 'cursor:50',
    });
    expect(query.text).toBe('sonnet');
    expect(query.cursor).toBe('cursor:50');
    expect(query.connectionIds).toEqual([]);
    expect(query.providerIds).toEqual([]);
    expect(query.capabilities).toEqual([]);
    expect(query.availableOnly).toBe(true);
  });

  it('produces a query Main will accept', () => {
    // `modelCatalogQueryInputSchema` is `.strict()`, so this fails on a field the contract does not
    // have as well as on one it requires and the picker forgot — the renderer and Main cannot drift
    // apart silently.
    const query = catalogQuery({
      taskId: 'task-a',
      text: 'gpt',
      accessType: 'subscription',
      cursor: null,
    });
    expect(modelCatalogQueryInputSchema.parse(query)).toEqual(query);
  });
});

describe('connectionLabel', () => {
  it('names the connection the catalog named', () => {
    // The built-in rows read 「Claude Code」/「Codex CLI」 because Main says so. Nothing here inspects
    // the connection id, the provider or the model to reach that answer.
    expect(connectionLabel(model())).toBe('Claude Code');
    expect(
      connectionLabel(
        model({ connectionId: 'builtin:codex-cli', connectionDisplayName: 'Codex CLI' }),
      ),
    ).toBe('Codex CLI');
    expect(
      connectionLabel(model({ connectionId: 'conn-7', connectionDisplayName: '本番 OpenAI' })),
    ).toBe('本番 OpenAI');
  });

  it('falls back to the id when the connection has no display name', () => {
    expect(connectionLabel(model({ connectionDisplayName: undefined }))).toBe('builtin:claude-cli');
  });
});

describe('describeModel', () => {
  it('describes the model, leaving the connection to its own line', () => {
    const meta = describeModel(model());
    expect(meta.startsWith('anthropic · ')).toBe(true);
    expect(meta).toContain('コンテキスト: 不明');
    // The row shows the connection once, by name — repeating the raw id in the meta line would put
    // the same fact on screen twice, in its least readable form.
    expect(meta).not.toContain('builtin:claude-cli');
  });
});

// Grouping the list by provider. The whole point of these cases is *where the answer comes from*:
// a connection or a published author, never a name that happens to look like a vendor's. A helper
// that read `displayName` would pass a naive eyeball test on today's catalog and then mis-group the
// first model whose name does not start with its author.

function author(value: string) {
  return { value, source: 'provider_api' as const };
}

describe('modelGroup under サブスク', () => {
  it('makes one band per connection, named the way the connection is named', () => {
    expect(modelGroup(model(), 'subscription')).toEqual({
      key: 'builtin:claude-cli',
      label: 'Claude Code',
    });
    expect(
      modelGroup(
        model({ connectionId: 'builtin:codex-cli', connectionDisplayName: 'Codex CLI' }),
        'subscription',
      ),
    ).toEqual({ key: 'builtin:codex-cli', label: 'Codex CLI' });
  });

  it('labels a nameless connection by its id rather than inventing one', () => {
    expect(modelGroup(model({ connectionDisplayName: undefined }), 'subscription')).toEqual({
      key: 'builtin:claude-cli',
      label: 'builtin:claude-cli',
    });
  });

  it('keeps two connections apart even when the user gave them the same name', () => {
    // Identity is the id, the label is the name. Two accounts a user called the same thing are
    // still two accounts, and merging them would offer a model on a connection the row is not on.
    const left = model({ connectionId: 'conn-1', connectionDisplayName: '本番' });
    const right = model({ connectionId: 'conn-2', connectionDisplayName: '本番' });
    expect(modelGroup(left, 'subscription').key).not.toBe(modelGroup(right, 'subscription').key);
    expect(modelGroup(left, 'subscription').label).toBe(modelGroup(right, 'subscription').label);
  });

  it('groups by the account even when the models were written by different authors', () => {
    // A subscription is one account's models; whose model it is upstream is not what the user is
    // choosing between here.
    const one = model({ modelId: 'a', displayName: 'A', modelAuthor: author('anthropic') });
    const two = model({ modelId: 'b', displayName: 'B', modelAuthor: author('google') });
    expect(modelGroup(one, 'subscription').key).toBe(modelGroup(two, 'subscription').key);
  });
});

describe('modelGroup under API', () => {
  const aggregator = {
    connectionId: 'conn-7',
    connectionDisplayName: 'My Aggregator',
    providerId: 'some-aggregator',
  };

  it('bands an API connection by the author the catalog published', () => {
    // One key can reach many vendors' models, so the connection is too coarse; `modelAuthor` is
    // the provider's own answer and the only one the picker will accept.
    expect(modelGroup(model({ ...aggregator, modelAuthor: author('anthropic') }), 'api')).toEqual({
      key: 'anthropic',
      label: 'anthropic',
    });
    expect(modelGroup(model({ ...aggregator, modelAuthor: author('meta-llama') }), 'api')).toEqual({
      key: 'meta-llama',
      label: 'meta-llama',
    });
  });

  it('falls back to the provider id when no author was published', () => {
    // Both shapes of "not published": the field absent, and the field present with a null value.
    expect(modelGroup(model({ ...aggregator, modelAuthor: undefined }), 'api')).toEqual({
      key: 'some-aggregator',
      label: 'some-aggregator',
    });
    expect(modelGroup(model({ ...aggregator, modelAuthor: unknown }), 'api')).toEqual({
      key: 'some-aggregator',
      label: 'some-aggregator',
    });
  });

  it('splits one connection into a band per author', () => {
    const left = model({ ...aggregator, modelId: 'x', modelAuthor: author('anthropic') });
    const right = model({ ...aggregator, modelId: 'y', modelAuthor: author('google') });
    expect(modelGroup(left, 'api').key).not.toBe(modelGroup(right, 'api').key);
  });

  it('reads the author and nothing else — not the display name, not the model id', () => {
    // Same author, names that share no word: one band. This is the case a `displayName`-derived
    // helper gets wrong.
    const renamed = model({
      ...aggregator,
      modelId: 'zephyr-9',
      displayName: '社内検証用モデル',
      modelAuthor: author('anthropic'),
    });
    const plain = model({
      ...aggregator,
      modelId: 'anthropic/claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      modelAuthor: author('anthropic'),
    });
    expect(modelGroup(renamed, 'api').key).toBe(modelGroup(plain, 'api').key);

    // And the mirror: identical names, different published authors — two bands. A name is text a
    // vendor chose, not a statement about who serves the model.
    const twin = model({ ...aggregator, modelAuthor: author('mistralai') });
    const other = model({ ...aggregator, modelAuthor: author('cohere') });
    expect(twin.displayName).toBe(other.displayName);
    expect(modelGroup(twin, 'api').key).not.toBe(modelGroup(other, 'api').key);
  });
});

describe('startsGroup', () => {
  const items = [
    model({ connectionId: 'conn-1', modelId: 'a', modelAuthor: author('anthropic') }),
    model({ connectionId: 'conn-1', modelId: 'b', modelAuthor: author('anthropic') }),
    model({ connectionId: 'conn-2', modelId: 'c', modelAuthor: author('google') }),
    model({ connectionId: 'conn-2', modelId: 'd', modelAuthor: author('google') }),
  ];

  it('opens a band on the first row and on every change of provider', () => {
    expect(items.map((_, index) => startsGroup(items, index, 'api'))).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('answers per access type, from the same rows', () => {
    // Rows 1 and 2 share a connection but not an author, so where the band breaks depends on which
    // question the toggle is asking.
    const mixed = [
      model({ connectionId: 'conn-1', modelId: 'a', modelAuthor: author('anthropic') }),
      model({ connectionId: 'conn-1', modelId: 'b', modelAuthor: author('google') }),
    ];
    expect(mixed.map((_, index) => startsGroup(mixed, index, 'subscription'))).toEqual([
      true,
      false,
    ]);
    expect(mixed.map((_, index) => startsGroup(mixed, index, 'api'))).toEqual([true, true]);
  });

  it('decides from the loaded list, not from what the scrollport has mounted', () => {
    // The renderer asks about absolute indexes into the whole page while mounting only a window of
    // it. A row deep in the list continues the band above it even though that row is not rendered.
    expect(startsGroup(items, 3, 'api')).toBe(false);
    expect(startsGroup(items, 2, 'api')).toBe(true);
  });

  it('says no for an index the list does not have', () => {
    expect(startsGroup(items, items.length, 'api')).toBe(false);
    expect(startsGroup([], 0, 'api')).toBe(false);
  });
});

describe('groupAtScrollTop', () => {
  const items = [
    model({ connectionId: 'conn-1', connectionDisplayName: '一番目' }),
    model({ connectionId: 'conn-1', connectionDisplayName: '一番目', modelId: 'b' }),
    model({ connectionId: 'conn-2', connectionDisplayName: '二番目', modelId: 'c' }),
  ];

  it('names the band the top of the scrollport is showing', () => {
    const at = (scrollTop: number) =>
      groupAtScrollTop({ items, scrollTop, rowHeightPx: 46, accessType: 'subscription' })?.label;
    expect(at(0)).toBe('一番目');
    // Part-way through row 1 is still row 1: the band is the row the top edge is over.
    expect(at(60)).toBe('一番目');
    expect(at(92)).toBe('二番目');
  });

  it('clamps rather than reading off the end of the list', () => {
    const at = (scrollTop: number) =>
      groupAtScrollTop({ items, scrollTop, rowHeightPx: 46, accessType: 'subscription' })?.label;
    expect(at(-20)).toBe('一番目');
    expect(at(10_000)).toBe('二番目');
  });

  it('has no answer for an empty list', () => {
    expect(
      groupAtScrollTop({ items: [], scrollTop: 0, rowHeightPx: 46, accessType: 'api' }),
    ).toBeNull();
  });
});

describe('AccessTypeToggle', () => {
  function segment(markup: string, label: string): string {
    const found = markup.split('<button').find((part) => part.includes(`>${label}</button>`));
    if (found === undefined) throw new Error(`セグメント「${label}」が描画されていません`);
    return found;
  }

  it('states which access is on with pressed semantics', () => {
    const markup = renderToStaticMarkup(
      <AccessTypeToggle value="subscription" onChange={() => {}} onDismiss={() => {}} />,
    );
    expect(segment(markup, 'サブスク')).toContain('aria-pressed="true"');
    expect(segment(markup, 'API')).toContain('aria-pressed="false"');
  });

  it('moves the pressed state with the selection rather than adding a second one', () => {
    const markup = renderToStaticMarkup(
      <AccessTypeToggle value="api" onChange={() => {}} onDismiss={() => {}} />,
    );
    expect(segment(markup, 'API')).toContain('aria-pressed="true"');
    expect(segment(markup, 'サブスク')).toContain('aria-pressed="false"');
    expect(markup.split('aria-pressed="true"')).toHaveLength(2);
  });

  it('is a labelled group of keyboard-native buttons', () => {
    // Real buttons: Tab reaches them and Space/Enter activate them without this component
    // reimplementing either. The group label is what a screen reader announces around the pair.
    const markup = renderToStaticMarkup(
      <AccessTypeToggle value="subscription" onChange={() => {}} onDismiss={() => {}} />,
    );
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="モデルの利用形態"');
    expect(markup.split('type="button"')).toHaveLength(3);
  });
});
