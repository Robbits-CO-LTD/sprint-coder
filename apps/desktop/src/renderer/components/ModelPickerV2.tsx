import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ModelCatalogQueryResult, ModelSelection, ProviderModel } from '@sprint-coder/contracts';
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
 * The multi-provider Model Picker (UI slice U1b), shown in place of the legacy `ModelChip` only
 * while Main reports `multiProviderModelPickerV2` for the Task.
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

/** The one-line summary under a row's name: where the model comes from, then what it can do. */
function describeModel(model: ProviderModel): string {
  return [
    `${model.providerId} · ${model.connectionId}`,
    contextLabel(model.contextWindow.value),
    capabilityLabel('ツール', model.toolCalling.value),
    capabilityLabel('推論', model.reasoning.value),
    capabilityLabel('画像入力', model.multimodalInput.value),
  ].join(' · ');
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
   * on pages this renderer has never seen. */
  const fetchPage = useCallback(
    async (cursor: string | null, searchText: string): Promise<void> => {
      const models = window.sprintCoder?.models;
      if (typeof models?.query !== 'function') {
        setFailed(true);
        return;
      }
      const request = cursor === null ? (queryRef.current += 1) : queryRef.current;
      inFlightRef.current = request;
      setLoading(true);
      try {
        const result: ModelCatalogQueryResult = await models.query({
          taskId,
          text: searchText,
          connectionIds: [],
          providerIds: [],
          capabilities: [],
          availableOnly: true,
          cursor,
          limit: PAGE_LIMIT,
        });
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
      void fetchPage(null, text);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, text, query, fetchPage]);

  /** Opening the picker loads the first page of whatever query it is showing — reopening re-reads
   * the catalog rather than presenting a page that may be minutes stale. */
  function openPicker() {
    setOpen(true);
    void fetchPage(null, query);
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
    void fetchPage(cursor, query);
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
          <div className="mpv2-count" role="status" aria-live="polite" data-testid="model-picker-v2-count">
            {countMessage}
          </div>
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
              return (
                <div
                  key={modelKey(model)}
                  id={optionId(index)}
                  role="option"
                  aria-selected={selected}
                  data-testid={`model-picker-v2-option-${model.modelId}`}
                  className={`mpv2-row${selected ? ' selected' : ''}${
                    index === activeIndex ? ' active' : ''
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(model)}
                >
                  <span className="mpv2-title">{model.displayName}</span>
                  <span className="mpv2-meta">{describeModel(model)}</span>
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
