import { useState } from 'react';
import type { Ref } from 'react';
import { Plus } from '../icons';

// Ghost "hire" node: same card anatomy as a Worker (dashed border instead of solid, see
// `.worker--hire` in index.css) sitting at the next free slot, letting the user spawn a new
// Worker directly on the canvas. Not present in the static demo (workers there are scripted).
export function HireNode({
  x,
  y,
  teamBusy,
  selected = false,
  onHire,
  ref,
}: {
  x: number;
  y: number;
  teamBusy: boolean;
  /** Keyboard-navigation selection ring (Slice 6.1 canvas keyboard nav). */
  selected?: boolean;
  onHire: (role: string, objective: string) => void;
  ref?: Ref<HTMLDivElement>;
}) {
  const [role, setRole] = useState('');
  const [objective, setObjective] = useState('');
  const canSubmit = !teamBusy && role.trim() !== '' && objective.trim() !== '';

  return (
    <div
      ref={ref}
      className={`worker worker--hire${selected ? ' node-selected' : ''}`}
      aria-label="Workerを雇用"
      style={{ left: x, top: y }}
    >
      <div className="w-head">
        <div className="w-avatar">
          <Plus size={14} />
        </div>
        <div className="role-line">
          <span className="role-name">Workerを雇用</span>
        </div>
      </div>
      <form
        className="hire-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onHire(role.trim(), objective.trim());
          setRole('');
          setObjective('');
        }}
      >
        <label>
          役割
          <input value={role} onChange={(event) => setRole(event.target.value)} maxLength={100} />
        </label>
        <label>
          目的
          <textarea
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            maxLength={10_000}
            rows={2}
          />
        </label>
        <button type="submit" data-testid="team-hire" className="cc-btn" disabled={!canSubmit}>
          Workerを起動
        </button>
      </form>
    </div>
  );
}
