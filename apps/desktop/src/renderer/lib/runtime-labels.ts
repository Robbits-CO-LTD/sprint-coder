import type { RuntimeKind } from '../types/sprint-coder';

// Shared user-facing Runtime labels. Extracted from Composer.tsx so the Composer chip and the
// SurfaceFooter's connection line cannot drift apart on what a Runtime is called — two surfaces
// naming the same thing differently is worse than either name.

export const RUNTIME_LABEL: Record<RuntimeKind, string> = {
  mock: 'Mock Runtime',
  codex: 'Codex',
  claude: 'Claude Code',
};
