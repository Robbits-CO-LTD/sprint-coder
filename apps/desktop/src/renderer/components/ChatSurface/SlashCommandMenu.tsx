import { useEffect, useRef } from 'react';
import type { SlashCommand, SlashCommandId } from './slash-commands';

export function SlashCommandMenu({
  commands,
  selectedIndex,
  unavailable,
  onSelect,
  onHover,
}: {
  commands: readonly SlashCommand[];
  selectedIndex: number;
  unavailable: Partial<Record<SlashCommandId, string>>;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <div
      id="composer-slash-commands"
      className="slash-command-menu"
      role="listbox"
      aria-label="スラッシュコマンド"
      data-testid="slash-command-menu"
    >
      <div className="slash-command-heading">
        <span>Commands</span>
        <span>↑↓ 選択 · Enter 実行 · Esc 閉じる</span>
      </div>
      {commands.length === 0 ? (
        <div className="slash-command-empty" role="status">
          一致するコマンドはありません
        </div>
      ) : (
        commands.map((command, index) => {
          const reason = unavailable[command.id];
          const selected = index === selectedIndex;
          return (
            <button
              key={command.id}
              ref={selected ? selectedRef : undefined}
              id={`slash-command-${command.id}`}
              data-testid={`slash-command-${command.id}`}
              type="button"
              role="option"
              aria-selected={selected}
              aria-disabled={reason === undefined ? undefined : true}
              className={`slash-command-item${selected ? ' selected' : ''}${
                reason === undefined ? '' : ' unavailable'
              }`}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                // Keep textarea focus stable; the click still activates the command.
                event.preventDefault();
              }}
              onClick={() => {
                if (reason === undefined) onSelect(command);
              }}
            >
              <span className="slash-command-name">{command.command}</span>
              <span className="slash-command-copy">
                <span className="slash-command-label">{command.label}</span>
                <span className="slash-command-description">{reason ?? command.description}</span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
