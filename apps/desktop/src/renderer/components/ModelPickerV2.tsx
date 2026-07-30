import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type {
  ModelCatalogAccessType,
  ModelCatalogQueryInput,
  ModelCatalogQueryResult,
  ModelSelection,
  ProviderModel,
} from '@sprint-coder/contracts';
import { useAppStore } from '../store/appStore';
import {
  resolveTriggerLabel,
  selectionForTask,
  type ChosenModel,
} from '../lib/model-picker-parity';
import {
  MODEL_LIST_OVERSCAN_ROWS,
  MODEL_LIST_VIEWPORT_PX,
  MODEL_PAGE_PREFETCH_ROWS,
  MODEL_ROW_HEIGHT_PX,
  needsNextPage,
  nextActiveIndex,
  scrollTopForIndex,
  virtualRange,
} from '../lib/model-picker-virtualization';

/**
 * The multi-provider Model Picker (UI slice U1b), shown in place of the legacy Runtime *and* Model
 * chips — one AI control instead of two — only while Main reports `multiProviderModelPickerV2` for
 * the Task.
 *
 * It reads *nothing* Runtime-specific. No `runtime.kind`, no `codexAvailable`/`claudeAvailable`, no
 * per-CLI model list: the whole surface is `window.sprintCoder.models` — a Main-owned catalog query
 * and a canonical per-Task selection write. That is the point of the slice. Anything the picker
 * cannot learn from a catalog row it says it does not know, rather than inferring it from which CLI
 * happens to be installed.
 *
 * Search, filtering, sorting and paging all happen in Main. The render path never walks a full
 * catalog — it holds one cursor page window at a time and mounts only the rows the scrollport can
 * show, so 2 models and 1200 models cost the same DOM.
 */

/** Rows per cursor page. Under the contract's 100 cap, and several viewports deep so scrolling
 * feels continuous rather than page-by-page. */
const PAGE_LIMIT = 50;
/** Search debounce. Long enough that a typed word is one query rather than one per keystroke,
 * short enough that the list still feels attached to the input. */
const SEARCH_DEBOUNCE_MS = 180;

const UNKNOWN = '不明';

/**
 * The two ways a Task can reach a model: a subscription the user is already signed in to, or an API
 * key they added. Which one a row is, is a property of its *connection* and only Main can classify
 * it — the picker names the two and hands the choice back as a catalog filter, so a connection that
 * changes category is Main's answer to change and not this component's.
 *
 * 「サブスク」 is the default because it is the access that works without the user configuring
 * anything, so the picker opens on what the app can already use.
 */
export const MODEL_ACCESS_OPTIONS: readonly { id: ModelCatalogAccessType; label: string }[] = [
  { id: 'api', label: 'API' },
  { id: 'subscription', label: 'サブスク' },
];
export const DEFAULT_ACCESS_TYPE: ModelCatalogAccessType = 'subscription';

type CatalogPage = {
  revision: number;
  total: number;
  items: ProviderModel[];
  nextCursor: string | null;
};

const EMPTY_PAGE: CatalogPage = { revision: -1, total: 0, items: [], nextCursor: null };

/** Identity of a catalog row. Connection-scoped, because the same `modelId` can legitimately exist
 * on two connections (the same model through two accounts) and they are not interchangeable.
 *
 * JSON rather than a joined string: both halves are free-form provider text, so any literal
 * separator could also occur inside a part and collapse two distinct rows onto one React key. JSON
 * escapes its own delimiters — and any control character — instead of carrying them through. */
function modelKey(model: ProviderModel): string {
  return JSON.stringify([model.connectionId, model.modelId]);
}

function isSelected(model: ProviderModel, selection: ModelSelection | null): boolean {
  if (selection === null) return false;
  return (
    selection.connectionId === model.connectionId && selection.requestedModel === model.modelId
  );
}

/** A capability the catalog left `null` is genuinely unknown — the provider did not publish it and
 * nothing observed it. Saying 「不明」 is the honest answer; rendering it as "no" would invent a
 * fact, and hiding it would make an unpublished capability indistinguishable from an absent one. */
function capabilityLabel(name: string, value: boolean | null): string {
  if (value === null) return `${name}: ${UNKNOWN}`;
  return `${name}: ${value ? '対応' : '非対応'}`;
}

function contextLabel(value: number | null): string {
  if (value === null) return `コンテキスト: ${UNKNOWN}`;
  return `コンテキスト: ${Math.round(value / 1000)}k`;
}

/** How a row names the connection it came from.
 *
 * The name is the connection's own — the one the user gave it, or the one Main ships for a built-in
 * CLI — so 「Claude Code」 and 「Codex CLI」 appear because the catalog says so, not because this file
 * knows which connection ids are built in. A connection with no display name is shown by id: that is
 * the most Main actually told us, and it beats inventing a friendlier name for it. */
export function connectionLabel(model: ProviderModel): string {
  return model.connectionDisplayName ?? model.connectionId;
}

/** A band of adjacent rows that come from the same provider, as the list draws it: `key` decides
 * where one band ends and the next begins, `label` is what the rail prints. */
export type ModelGroup = { key: string; label: string };

/** Which provider a row belongs to — the only question this file asks about a row's origin, and it
 * asks the catalog rather than answering from anything it knows about a vendor.
 *
 * The answer differs by access because "provider" means a different thing on each side:
 *
 *  - サブスク: a connection *is* the account the user thinks in, so one connection is one band.
 *    Identity is `connectionId` and not the name shown, because two connections may legitimately
 *    carry the same display name and they are still two different accounts to pick between.
 *  - API: one key can reach many vendors' models — an aggregator connection is a whole catalog, so
 *    the connection is too coarse to group by. `modelAuthor` is the catalog's own answer to "whose
 *    model is this" and is used wherever the provider published it; where it did not, `providerId`
 *    is the most Main actually told us. There the label *is* the identity: two adjacent bands the
 *    user cannot tell apart would read as a bug, and only one access type is ever on screen, so
 *    nothing else in the list can collide with those strings.
 *
 * `displayName` and `modelId` are never read here. A name is text a vendor chose for a product; it
 * is not a statement about who serves it, and reading one to guess the other is the inference this
 * slice exists to remove.
 */
export function modelGroup(model: ProviderModel, accessType: ModelCatalogAccessType): ModelGroup {
  if (accessType === 'subscription') {
    return { key: model.connectionId, label: connectionLabel(model) };
  }
  const label = model.modelAuthor?.value ?? model.providerId;
  return { key: label, label };
}

/** Whether the row at `index` opens a band — that is, whether the row before it came from another
 * provider.
 *
 * Asked against the whole loaded list, never the mounted window: a band that began above the
 * scrollport is still the same band, and windowing decides what is on screen, not what the list
 * means. Index 0 opens a band by definition — the caller decides whether the list's first band also
 * draws a boundary above itself, since there is nothing there to separate it from. */
export function startsGroup(
  items: readonly ProviderModel[],
  index: number,
  accessType: ModelCatalogAccessType,
): boolean {
  const model = items[index];
  if (model === undefined) return false;
  const previous = items[index - 1];
  if (previous === undefined) return true;
  return modelGroup(previous, accessType).key !== modelGroup(model, accessType).key;
}

/** The band sitting at the scrollport's top edge, for the cue above the list.
 *
 * The rail names a band only where it starts, so a user who scrolled into the middle of a long one
 * needs this to answer "whose models am I looking at". Rows are a constant tall, so the top row is
 * arithmetic — nothing is measured, and the answer does not depend on which rows are mounted. */
export function groupAtScrollTop(args: {
  items: readonly ProviderModel[];
  scrollTop: number;
  rowHeightPx: number;
  accessType: ModelCatalogAccessType;
}): ModelGroup | null {
  const { items, scrollTop, rowHeightPx, accessType } = args;
  if (items.length === 0 || rowHeightPx <= 0) return null;
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(scrollTop / rowHeightPx)));
  const model = items[index];
  return model === undefined ? null : modelGroup(model, accessType);
}

/** The one-line summary under a row's name: which provider serves the model, then what it can do.
 * The connection is named on the row's first line instead of repeated here. */
export function describeModel(model: ProviderModel): string {
  return [
    model.providerId,
    contextLabel(model.contextWindow.value),
    capabilityLabel('ツール', model.toolCalling.value),
    capabilityLabel('推論', model.reasoning.value),
    capabilityLabel('画像入力', model.multimodalInput.value),
  ].join(' · ');
}

/** One page's worth of catalog query.
 *
 * Every field is stated, `accessTypes` included — that array is the toggle's entire effect. The
 * narrowing happens in Main against the connection's access, so the picker never has to work out
 * what kind of connection a row came from, only which kind the user asked to see. */
export function catalogQuery(args: {
  taskId: string;
  text: string;
  accessType: ModelCatalogAccessType;
  cursor: string | null;
}): ModelCatalogQueryInput {
  return {
    taskId: args.taskId,
    text: args.text,
    connectionIds: [],
    providerIds: [],
    accessTypes: [args.accessType],
    capabilities: [],
    availableOnly: true,
    cursor: args.cursor,
    limit: PAGE_LIMIT,
  };
}

/** The API / サブスク segmented control.
 *
 * Two real `<button>`s in a group rather than a custom widget: they are keyboard-native already, and
 * `aria-pressed` states which one is on, so nothing here reimplements focus or key handling. Escape
 * is forwarded so the popup still closes while focus sits on the toggle — the same key the search
 * field honours one row above. */
export function AccessTypeToggle({
  value,
  onChange,
  onDismiss,
}: {
  value: ModelCatalogAccessType;
  onChange: (next: ModelCatalogAccessType) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="mpv2-access"
      role="group"
      aria-label="モデルの利用形態"
      data-testid="model-picker-v2-access"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onDismiss();
      }}
    >
      {MODEL_ACCESS_OPTIONS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          data-testid={`model-picker-v2-access-${id}`}
          className={`mpv2-access-btn${value === id ? ' active' : ''}`}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ModelPickerV2({ taskId }: { taskId: string }) {
  // Scoped to this Task, not just read off the slot: the store holds one canonical selection at a
  // time, so between a Task switch and that Task's answer arriving the slot still describes the
  // Task the user left. Ticking a row — or labelling the trigger — from that would attribute
  // another Task's model to this one (Team v2 UI slice U2).
  const selection = useAppStore((s) => selectionForTask(s.modelPicker, taskId));
  const setModelSelection = useAppStore((s) => s.setModelSelection);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [accessType, setAccessType] = useState<ModelCatalogAccessType>(DEFAULT_ACCESS_TYPE);
  const [page, setPage] = useState<CatalogPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  // The row the user picked, so the trigger can show a name rather than an id between the write and
  // the next time the catalog is queried. Its identity is kept with the name so the name can be
  // disowned as soon as the canonical selection points somewhere else — a local label is a display
  // convenience, never a second answer to "which model is this Task on".
  const [chosen, setChosen] = useState<ChosenModel | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Monotonic query id: a slow first page for "gpt" must not land on top of a newer "claude", and a
  // cursor page fetched under the old query must not be appended to the new one's rows.
  const queryRef = useRef(0);
  // The query id of the request currently in flight, or null. One page request at a time — without
  // this, a scroll and an ArrowDown in the same frame both see the same `nextCursor` and fetch it
  // twice, appending the same rows twice. A ref, not `loading`, because state updates land a render
  // too late to guard the second caller.
  const inFlightRef = useRef<number | null>(null);
  // Mirrors the loaded page's catalog revision, so a response can tell "append" from "replace"
  // before `setPage`'s updater runs — the scroll/active reset has to happen outside it.
  const revisionRef = useRef(EMPTY_PAGE.revision);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const range = virtualRange({
    itemCount: page.items.length,
    scrollTop,
    viewportHeightPx: MODEL_LIST_VIEWPORT_PX,
    rowHeightPx: MODEL_ROW_HEIGHT_PX,
    overscanRows: MODEL_LIST_OVERSCAN_ROWS,
  });
  const active = page.items[activeIndex];
  // Which provider band the scrollport is on. Derived from `scrollTop` rather than stored, so it
  // follows both wheel scrolling and keyboard movement (which scrolls through the same state)
  // without a second source of truth to keep in step.
  const topGroup = groupAtScrollTop({
    items: page.items,
    scrollTop,
    rowHeightPx: MODEL_ROW_HEIGHT_PX,
    accessType,
  });

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  /** Asks Main for one page.
   *
   * `cursor === null` means "first page of `searchText`" and starts a new query context, which
   * invalidates every response still in flight; a cursor page inherits the context it was requested
   * under. Search, filtering and ordering are Main's — this never narrows the rows it already holds,
   * because they are one page of a catalog and filtering them here would hide the matches that live
   * on pages this renderer has never seen. The access type is passed per call rather than read from
   * state, so a cursor page can only ever extend the list it was requested for. */
  const fetchPage = useCallback(
    async (
      cursor: string | null,
      searchText: string,
      access: ModelCatalogAccessType,
    ): Promise<void> => {
      const models = window.sprintCoder?.models;
      if (typeof models?.query !== 'function') {
        setFailed(true);
        return;
      }
      const request = cursor === null ? (queryRef.current += 1) : queryRef.current;
      inFlightRef.current = request;
      setLoading(true);
      try {
        const result: ModelCatalogQueryResult = await models.query(
          catalogQuery({ taskId, text: searchText, accessType: access, cursor }),
        );
        if (queryRef.current !== request) return;
        // Appending is only meaningful inside one catalog revision: a catalog that changed under
        // the cursor makes the offsets the cursor encodes meaningless, so the honest move is to
        // take the new page as the whole list rather than splice two revisions into one that never
        // existed.
        const replace = cursor === null || result.revision !== revisionRef.current;
        revisionRef.current = result.revision;
        setPage((current) => ({
          revision: result.revision,
          total: result.total,
          items: replace ? [...result.items] : [...current.items, ...result.items],
          nextCursor: result.nextCursor,
        }));
        setFailed(false);
        if (replace) {
          setActiveIndex(0);
          setScrollTop(0);
          if (listRef.current) listRef.current.scrollTop = 0;
        }
      } catch {
        if (queryRef.current !== request) return;
        if (cursor === null) {
          revisionRef.current = EMPTY_PAGE.revision;
          setPage(EMPTY_PAGE);
          setFailed(true);
        } else {
          // Keep what is already loaded and stop paging; the user can still pick from it.
          setPage((current) => ({ ...current, nextCursor: null }));
        }
      } finally {
        if (inFlightRef.current === request) inFlightRef.current = null;
        if (queryRef.current === request) setLoading(false);
      }
    },
    [taskId],
  );

  // Debounce the typed text into a *new query to Main*, not into a local filter: the loaded rows
  // are one page of a catalog, so narrowing them here would hide every match that lives on a page
  // this renderer has never seen. Fetching from the timer rather than from an effect on `query`
  // keeps the request tied to the interaction that caused it — the popup being closed cancels the
  // pending search instead of firing it at nothing.
  useEffect(() => {
    if (!open || text === query) return;
    const timer = setTimeout(() => {
      setQuery(text);
      void fetchPage(null, text, accessType);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, text, query, accessType, fetchPage]);

  /** Opening the picker loads the first page of whatever query it is showing — reopening re-reads
   * the catalog rather than presenting a page that may be minutes stale. */
  function openPicker() {
    setOpen(true);
    void fetchPage(null, query, accessType);
  }

  /** Switching access is a different catalog, not a filter over the loaded one: the rows on screen
   * belong to the access the user just left, and the cursor into them is an offset into a list that
   * is about to be replaced. So the loaded page, the active row and the scroll offset all go back to
   * their opening state and the first page is fetched for the search that is on screen — including
   * text still inside the debounce window, which is committed here so the pending timer does not
   * re-issue the same query a moment later. Starting a first page also invalidates any response
   * still in flight for the access type being left. */
  function selectAccessType(next: ModelCatalogAccessType) {
    if (next === accessType) return;
    setAccessType(next);
    setQuery(text);
    revisionRef.current = EMPTY_PAGE.revision;
    setPage(EMPTY_PAGE);
    setActiveIndex(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
    setFailed(false);
    void fetchPage(null, text, next);
  }

  /** Moves the active option and brings it into the scrollport in the same handler.
   *
   * Not an effect: with windowing an option that scrolled out of range is unmounted, and
   * `aria-activedescendant` may only name an element that exists — so the scroll has to land in the
   * same commit as the index, not one render later. */
  function moveActive(index: number) {
    setActiveIndex(index);
    const next = scrollTopForIndex({
      index,
      scrollTop,
      viewportHeightPx: MODEL_LIST_VIEWPORT_PX,
      rowHeightPx: MODEL_ROW_HEIGHT_PX,
    });
    if (next !== scrollTop) {
      setScrollTop(next);
      if (listRef.current) listRef.current.scrollTop = next;
    }
    maybeLoadNextPage(next, index);
  }

  /** Fetches the next cursor page if this scroll offset / active row has come close enough to the
   * end of the loaded rows. Called from the interactions that move either — not from an effect,
   * because a query is something the user's action causes, not state React has to synchronize. */
  function maybeLoadNextPage(atScrollTop: number, atActiveIndex: number) {
    const cursor = page.nextCursor;
    if (cursor === null || inFlightRef.current !== null || failed) return;
    const at = virtualRange({
      itemCount: page.items.length,
      scrollTop: atScrollTop,
      viewportHeightPx: MODEL_LIST_VIEWPORT_PX,
      rowHeightPx: MODEL_ROW_HEIGHT_PX,
      overscanRows: MODEL_LIST_OVERSCAN_ROWS,
    });
    if (
      !needsNextPage({
        endIndex: at.endIndex,
        activeIndex: atActiveIndex,
        itemCount: page.items.length,
        hasMore: true,
        prefetchRows: MODEL_PAGE_PREFETCH_ROWS,
      })
    )
      return;
    void fetchPage(cursor, query, accessType);
  }

  // Focus moves into the popup on open (NFR-A11Y-02): the search field is where the interaction
  // starts, and it is also the combobox that owns `aria-activedescendant`.
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      const wrap = wrapRef.current;
      if (wrap && !wrap.contains(e.target as Node)) {
        // Only reclaim focus if the popup still held it — otherwise unmounting it would drop focus
        // to <body>, and stealing it back would fight a deliberate click elsewhere.
        close(wrap.contains(document.activeElement));
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open]);

  function choose(model: ProviderModel) {
    setChosen({
      connectionId: model.connectionId,
      requestedModel: model.modelId,
      displayName: model.displayName,
    });
    close(true);
    void setModelSelection(taskId, {
      connectionId: model.connectionId,
      requestedProvider: model.providerId,
      requestedModel: model.modelId,
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (active) choose(active);
      return;
    }
    const moved = nextActiveIndex(e.key, activeIndex, page.items.length);
    if (moved !== null) {
      e.preventDefault();
      moveActive(moved);
    }
  }

  // Reads through the canonical selection every render, so an external change — a legacy
  // Runtime/Model write, a Main answer that normalised the request, a rejected write rolled back —
  // takes the local name with it instead of leaving the trigger asserting the old choice.
  const triggerLabel = resolveTriggerLabel(selection, chosen);
  const countMessage = failed
    ? 'モデル一覧を取得できませんでした'
    : loading && page.items.length === 0
      ? '検索中'
      : `${page.total}件中${page.items.length}件を読み込み済み`;

  return (
    <div className="runtime-chip-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        data-testid="model-picker-v2-trigger"
        type="button"
        className="cmp-chip runtime-chip model-chip"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(true) : openPicker())}
        title="Modelを選択"
      >
        {triggerLabel}
      </button>
      {open && (
        <div className="runtime-menu model-picker-v2" data-testid="model-picker-v2">
          <input
            ref={inputRef}
            data-testid="model-picker-v2-search"
            className="mpv2-search"
            type="text"
            role="combobox"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="モデルを検索"
            aria-label="モデルを検索"
            aria-expanded
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(activeIndex) : undefined}
          />
          <AccessTypeToggle
            value={accessType}
            onChange={selectAccessType}
            onDismiss={() => close(true)}
          />
          <div
            className="mpv2-count"
            role="status"
            aria-live="polite"
            data-testid="model-picker-v2-count"
          >
            {countMessage}
          </div>
          {/* The current band, named above the list. `aria-hidden` because it states nothing new:
              it repeats the rail of a row that is already in the listbox, and the count line
              directly above it is a live region — a second changing text node beside one is noise
              a screen reader user did not ask for. The listbox itself still announces every row
              through `aria-activedescendant`. */}
          {topGroup !== null && (
            <div
              className="mpv2-group-cue"
              data-testid="model-picker-v2-group-cue"
              aria-hidden="true"
            >
              {topGroup.label}
            </div>
          )}
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="モデル候補"
            className="mpv2-list"
            style={{ height: `${MODEL_LIST_VIEWPORT_PX}px` }}
            onScroll={(e) => {
              const top = e.currentTarget.scrollTop;
              setScrollTop(top);
              maybeLoadNextPage(top, activeIndex);
            }}
          >
            <div style={{ height: `${range.topPadPx}px` }} aria-hidden="true" />
            {page.items.slice(range.startIndex, range.endIndex).map((model, offset) => {
              const index = range.startIndex + offset;
              const selected = isSelected(model, selection);
              // Grouping is drawn *inside* the row — a rail column that names its band where the
              // band starts, and a hairline above that row. No header entry, because a header would
              // be a list item of a different height and the window arithmetic rests on every row
              // being exactly MODEL_ROW_HEIGHT_PX; it would also be a non-option child of the
              // listbox for the keyboard and `aria-activedescendant` to step around.
              const opensGroup = startsGroup(page.items, index, accessType);
              return (
                <div
                  key={modelKey(model)}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  data-testid={`model-picker-v2-option-${model.modelId}`}
                  className={`mpv2-row${selected ? ' selected' : ''}${
                    index === activeIndex ? ' active' : ''
                  }${opensGroup && index > 0 ? ' group-break' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(model)}
                >
                  {/* The rail runs down every row so a band reads as one block; only the row that
                      opens the band prints its name, so the same word is not repeated six times
                      down the list. */}
                  <span className="mpv2-rail">
                    {opensGroup && (
                      <span className="mpv2-rail-label">{modelGroup(model, accessType).label}</span>
                    )}
                  </span>
                  <span className="mpv2-body">
                    <span className="mpv2-head">
                      <span className="mpv2-title">{model.displayName}</span>
                      {/* Which connection this row is reached through, on the line the user reads
                          first. It is the answer to "which of my accounts is this?" — two rows can
                          otherwise carry the same model name — and under the サブスク toggle it is
                          what makes the built-in rows legible as 「Claude Code」/「Codex CLI」. It
                          stays on every row even where the rail names the same connection: a row
                          the user arrows onto mid-band must still say which account it is. */}
                      <span className="mpv2-conn">{connectionLabel(model)}</span>
                    </span>
                    <span className="mpv2-meta">{describeModel(model)}</span>
                  </span>
                </div>
              );
            })}
            <div style={{ height: `${range.bottomPadPx}px` }} aria-hidden="true" />
          </div>
          {page.items.length === 0 && !loading && (
            <div className="mpv2-empty">
              {failed ? 'モデル一覧を取得できませんでした' : '一致するモデルがありません'}
            </div>
          )}
          {loading && page.items.length > 0 && <div className="mpv2-more">読み込み中…</div>}
        </div>
      )}
    </div>
  );
}
