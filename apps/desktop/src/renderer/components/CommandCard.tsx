import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandOutputRecord } from '../types/vibe';
import type { CommandCardState } from '../store/appStore';
import {
  commandDurationMs,
  exactArgvDisplay,
  projectCommandLines,
} from '../store/command-projection';

const LINE_HEIGHT = 22;
const VIEWPORT_HEIGHT = 242;
const OVERSCAN = 8;

const RISK_LABEL = { low: '低リスク', medium: '中リスク', high: '高リスク' } as const;

export function CommandCard({ taskId, card }: { taskId: string; card: CommandCardState }) {
  const { command, tail } = card;
  const [expanded, setExpanded] = useState(false);
  const [outputs, setOutputs] = useState<CommandOutputRecord[]>([]);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [now, setNow] = useState(Date.now());
  const expandedRef = useRef(false);
  const cursorRef = useRef(0);
  const loadingRef = useRef(false);
  const targetOutputSeqRef = useRef(tail.lastOutputSeq);
  targetOutputSeqRef.current = tail.lastOutputSeq;
  const exactCommand = useMemo(
    () => exactArgvDisplay(command.executable, command.argv),
    [command.argv, command.executable],
  );

  useEffect(() => {
    if (command.state !== 'running' && command.state !== 'starting') return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [command.state]);

  async function loadOutput(reset: boolean): Promise<void> {
    if (!window.vibe || typeof window.vibe.commands?.outputPage !== 'function') return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setOutputError(null);
    let afterSeq = reset ? 0 : cursorRef.current;
    const loaded: CommandOutputRecord[] = [];
    let succeeded = false;
    try {
      for (;;) {
        const page = await window.vibe.commands.outputPage({
          taskId,
          commandId: command.id,
          afterSeq,
          limit: 200,
          maxBytes: 262_144,
        });
        loaded.push(...page.items);
        if (page.nextAfterSeq < afterSeq || (!page.eof && page.nextAfterSeq === afterSeq))
          throw new Error('コマンド出力のcursorが進みませんでした');
        afterSeq = page.nextAfterSeq;
        if (page.eof) break;
      }
      cursorRef.current = afterSeq;
      setOutputs((current) => {
        const base = reset ? [] : current;
        const bySeq = new Map(base.map((item) => [item.seq, item]));
        for (const item of loaded) bySeq.set(item.seq, item);
        return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
      });
      succeeded = true;
    } catch (error) {
      setOutputError(error instanceof Error ? error.message : '出力を読み込めませんでした');
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (expandedRef.current && succeeded && targetOutputSeqRef.current > cursorRef.current)
        queueMicrotask(() => void loadOutput(false));
    }
  }

  useEffect(() => {
    if (expanded && tail.lastOutputSeq > cursorRef.current) void loadOutput(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, tail.lastOutputSeq]);

  const fullLines = useMemo(() => projectCommandLines(outputs), [outputs]);
  const firstVisible = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN);
  const lastVisible = Math.min(
    fullLines.length,
    Math.ceil((scrollTop + VIEWPORT_HEIGHT) / LINE_HEIGHT) + OVERSCAN,
  );
  const visibleLines = fullLines.slice(firstVisible, lastVisible);
  const duration = commandDurationMs(command, now);

  function toggleExpanded(): void {
    if (expanded) {
      expandedRef.current = false;
      setExpanded(false);
      return;
    }
    cursorRef.current = 0;
    expandedRef.current = true;
    setOutputs([]);
    setExpanded(true);
    void loadOutput(true);
  }

  return (
    <section
      className={`command-card command-card--${command.state}`}
      data-testid="command-card"
      aria-label="コマンド実行"
    >
      <header className="command-card__head">
        <span className="command-card__kind">Command</span>
        <span className="command-card__status">{commandStatus(command)}</span>
        <span className={`command-card__risk risk-${command.risk}`}>
          {RISK_LABEL[command.risk]}
        </span>
        <span className="command-card__duration" data-testid="command-duration">
          {formatDuration(duration)}
        </span>
      </header>
      <div className="command-card__body">
        <p className="command-card__purpose">{command.purpose}</p>
        <div className="command-card__fact">
          <span>cwd</span>
          <code>{command.cwd}</code>
        </div>
        <div className="command-card__fact">
          <span>argv</span>
          <code>{exactCommand}</code>
          <button
            type="button"
            className="command-card__copy"
            onClick={() => void navigator.clipboard.writeText(exactCommand)}
            aria-label="コマンドをコピー"
          >
            Copy
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="command-card__expanded">
          <div className="command-card__environment">
            <span>environment</span>
            <code>{JSON.stringify(command.envDelta)}</code>
          </div>
          <div
            className="command-card__output command-card__output--virtual"
            role="log"
            aria-label="コマンドの全出力"
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div style={{ height: fullLines.length * LINE_HEIGHT, position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: firstVisible * LINE_HEIGHT,
                }}
              >
                {visibleLines.map((line, index) => (
                  <div
                    className={`command-card__output-line is-${line.stream}`}
                    data-stream={line.stream}
                    key={`${line.outputSeq}:${firstVisible + index}`}
                  >
                    <span className="sr-only">{line.stream}: </span>
                    {line.text || ' '}
                  </div>
                ))}
              </div>
            </div>
          </div>
          {loading ? <p className="command-card__notice">出力を読み込み中…</p> : null}
          {outputError ? (
            <p className="command-card__notice is-error" role="alert">
              {outputError}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="command-card__output" role="log" aria-label="コマンドの直近の出力">
          {tail.lines.map((line, index) => (
            <div
              className={`command-card__output-line is-${line.stream}`}
              data-stream={line.stream}
              key={`${line.outputSeq}:${index}`}
            >
              <span className="sr-only">{line.stream}: </span>
              {line.text || ' '}
            </div>
          ))}
        </div>
      )}

      <footer className="command-card__footer">
        {command.truncated ? <span>出力上限に達しました</span> : <span />}
        <button type="button" onClick={toggleExpanded}>
          {expanded ? '出力を折り畳む' : '出力を展開'}
        </button>
      </footer>
    </section>
  );
}

function commandStatus(command: CommandCardState['command']): string {
  if (command.state === 'exited') return `exit ${command.exitCode ?? '?'}`;
  if (command.state === 'canceled') return 'canceled';
  if (command.state === 'failed') return 'failed';
  if (command.state === 'interrupted') return 'interrupted';
  return command.state === 'running' ? 'running' : 'starting';
}

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
