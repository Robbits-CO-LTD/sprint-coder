import { useEffect, useRef, useState } from 'react';
import { virtualWindow } from './skill-picker';

export type SlashMenuItem = Readonly<{
  key: string;
  group: 'コマンド' | 'Chat Skills' | 'Team Skills' | 'Built-in Skills';
  command: string;
  label: string;
  description: string;
  unavailable?: string;
}>;

const ROW_HEIGHT = 58;
const VIEWPORT_HEIGHT = 290;

export function SlashCommandMenu({
  items,
  selectedIndex,
  onSelect,
  onHover,
}: {
  items: readonly SlashMenuItem[];
  selectedIndex: number;
  onSelect: (item: SlashMenuItem) => void;
  onHover: (index: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const visible = virtualWindow(items.length, scrollTop, VIEWPORT_HEIGHT, ROW_HEIGHT);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = bottom - viewport.clientHeight;
  }, [selectedIndex]);

  return (
    <div
      id="composer-slash-commands"
      className="slash-command-menu"
      role="listbox"
      aria-label="コマンドとSkill"
      data-testid="slash-command-menu"
    >
      <div className="slash-command-heading">
        <span>Commands & Skills</span>
        <span>↑↓ 選択 · Enter 追加 · Esc 閉じる</span>
      </div>
      {items.length === 0 ? (
        <div className="slash-command-empty" role="status">
          一致するコマンドまたはSkillはありません
        </div>
      ) : (
        <div
          ref={viewportRef}
          className="slash-command-viewport"
          style={{ maxHeight: VIEWPORT_HEIGHT }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: visible.paddingTop }} aria-hidden="true" />
          {items.slice(visible.start, visible.end).map((item, offset) => {
            const index = visible.start + offset;
            const selected = index === selectedIndex;
            const testId = item.key.startsWith('command:')
              ? `slash-command-${item.key.slice('command:'.length)}`
              : `slash-item-${item.key}`;
            return (
              <button
                key={item.key}
                id={`slash-item-${item.key}`}
                data-testid={testId}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={item.unavailable === undefined ? undefined : true}
                className={`slash-command-item${selected ? ' selected' : ''}${
                  item.unavailable === undefined ? '' : ' unavailable'
                }`}
                style={{ height: ROW_HEIGHT }}
                onMouseEnter={() => onHover(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  if (item.unavailable === undefined) onSelect(item);
                }}
              >
                <span className="slash-command-name">{item.command}</span>
                <span className="slash-command-copy">
                  <span className="slash-command-label">{item.label}</span>
                  <span className="slash-command-description">
                    {item.unavailable ?? item.description}
                  </span>
                </span>
                <span className="slash-command-group">{item.group}</span>
              </button>
            );
          })}
          <div style={{ height: visible.paddingBottom }} aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
