import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from './context-ledger';
import {
  BUILTIN_TEAM_SKILL_CONTENT,
  BUILTIN_TEAM_SKILL_DIGEST,
  BUILTIN_TEAM_SKILL_FRAGMENT_ID,
} from './team-skill';
import { TEAM_ASSIGN_TASK_TOOL, TEAM_TOOLS } from './team-tools';

// The Leader's guidance is a promise about an API, and it is written by hand while the API is
// generated from `TEAM_TOOLS`. Nothing makes the two agree, so they drift: a tool gets renamed, an
// argument is added, a tool is registered and never documented — and the guidance keeps confidently
// describing the version that used to exist. The Leader then calls a tool that is not there, or
// passes a field the schema rejects, and the failure surfaces as a confused model rather than as a
// broken build.
//
// These tests are that missing link. They do not review the prose; they check the claims in it that
// can be checked mechanically, so drift fails here instead of at runtime.

/** Model-facing names, which is what the guidance can legitimately mention. */
const REGISTERED_TOOL_NAMES = TEAM_TOOLS.map((tool) => tool.providerName);

/**
 * Registered tools the guidance deliberately does not walk the Leader through.
 *
 * Every registered tool is advertised over the MCP bridge, so the Leader can already see and call
 * these two; leaving them out of the guidance withholds nothing, it only declines to teach them.
 * That is the point. Both are lower-level alternatives to steps the guidance does teach —
 * `team_wait_events` polls where `team_wait_reports` waits for terminal reports, and
 * `team_send_to_worker` messages a Worker mid-task where `team_assign_task` states the whole job up
 * front — and describing them inline invites their use as substitutes for the sequence that makes
 * completion legible. Adding a name here should be as considered as documenting it.
 */
const INTENTIONALLY_UNDOCUMENTED = new Set(['team_send_to_worker', 'team_wait_events']);

/**
 * A ceiling, not a target. The guidance is injected into every Team turn, so growth is paid on each
 * one; the number is loose enough that ordinary edits pass and tight enough that a doubling does
 * not slip through unnoticed.
 */
const GUIDANCE_TOKEN_BUDGET = 1_200;

describe('Leader guidance names only tools that exist', () => {
  it('mentions no tool that is not registered', () => {
    const mentioned = [...new Set(BUILTIN_TEAM_SKILL_CONTENT.match(/\bteam_[a-z_]+\b/g) ?? [])];
    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.filter((name) => !REGISTERED_TOOL_NAMES.includes(name))).toEqual([]);
  });

  it('documents every registered tool that is not knowingly left out', () => {
    const undocumented = REGISTERED_TOOL_NAMES.filter(
      (name) => !BUILTIN_TEAM_SKILL_CONTENT.includes(name),
    );
    expect(undocumented.slice().sort()).toEqual([...INTENTIONALLY_UNDOCUMENTED].slice().sort());
  });

  it('keeps every listed exemption pointing at a tool that still exists', () => {
    for (const name of INTENTIONALLY_UNDOCUMENTED) expect(REGISTERED_TOOL_NAMES).toContain(name);
  });

  it('tells the Leader how to end a Worker, since nothing else in the sequence can', () => {
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('team_stop_worker');
    // Stopping must not become a way to declare the work finished.
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('completedとして報告しない');
  });
});

describe('Leader guidance describes the real assign-task arguments', () => {
  // The guidance tells the Leader that `team_assign_task` takes these three and nothing else, and
  // that everything else belongs in the objective text. That sentence is only safe while it matches
  // the schema the call is validated against.
  const schema = TEAM_ASSIGN_TASK_TOOL.inputSchema as {
    properties: Record<string, unknown>;
    required: readonly string[];
  };

  it('names exactly the accepted arguments', () => {
    const promised = ['workerId', 'objective', 'doneCriteria', 'access'];
    expect(Object.keys(schema.properties).slice().sort()).toEqual(promised.slice().sort());
    for (const argument of promised)
      expect(BUILTIN_TEAM_SKILL_CONTENT).toContain(`\`${argument}\``);
  });

  it('rejects the extra fields the guidance tells the Leader not to send', () => {
    expect(
      (TEAM_ASSIGN_TASK_TOOL.inputSchema as { additionalProperties: boolean }).additionalProperties,
    ).toBe(false);
    expect(BUILTIN_TEAM_SKILL_CONTENT).toContain('追加フィールドにせず');
  });
});

describe('Leader guidance stays within its budget and its digest stays honest', () => {
  it('fits the per-turn token budget', () => {
    expect(estimateTokens(BUILTIN_TEAM_SKILL_CONTENT)).toBeLessThanOrEqual(GUIDANCE_TOKEN_BUDGET);
  });

  it('publishes a digest of the content it actually ships', () => {
    expect(BUILTIN_TEAM_SKILL_DIGEST).toBe(
      createHash('sha256').update(BUILTIN_TEAM_SKILL_CONTENT).digest('hex'),
    );
  });

  it('binds the fragment identity to that digest, so edited guidance cannot pass as accepted', () => {
    expect(BUILTIN_TEAM_SKILL_FRAGMENT_ID).toContain(BUILTIN_TEAM_SKILL_DIGEST);
  });
});
