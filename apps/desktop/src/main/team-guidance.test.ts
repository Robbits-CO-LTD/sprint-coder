import { describe, expect, it } from 'vitest';
import { LEADER_MCP_SYSTEM_PROMPT } from './team-tools';

describe('Leader MCP system prompt', () => {
  it('requires real MCP calls for explicit Team requests', () => {
    expect(LEADER_MCP_SYSTEM_PROMPT).toContain('明示的なTeam依頼は必須');
    expect(LEADER_MCP_SYSTEM_PROMPT).toContain('依頼の大小にかかわらず');
    expect(LEADER_MCP_SYSTEM_PROMPT).toContain('必ずTeam MCPツールを実際に呼び出してください');
    expect(LEADER_MCP_SYSTEM_PROMPT).toContain('人数指定があれば最大3人の範囲でその人数');
  });

  it('names the MCP server, all orchestration calls, and forbids simulated reports', () => {
    expect(LEADER_MCP_SYSTEM_PROMPT).toContain('MCPサーバー `team`');
    for (const tool of [
      'team_hire_worker',
      'team_send_to_worker',
      'team_wait_reports',
    ]) {
      expect(LEADER_MCP_SYSTEM_PROMPT).toContain(`\`${tool}\``);
    }
    expect(LEADER_MCP_SYSTEM_PROMPT).toContain('必ずMCPツール呼び出しとして実行');
    expect(LEADER_MCP_SYSTEM_PROMPT).toContain(
      '呼び出していないWorker、届いていない報告、行われていない議論を捏造・要約してはいけません',
    );
  });

  it('keeps discretion only for requests without explicit Team intent', () => {
    expect(LEADER_MCP_SYSTEM_PROMPT).toContain('明示的なTeam依頼ではない場合のみ');
  });
});
