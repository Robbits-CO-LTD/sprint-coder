import type { ProviderTool } from '@sprint-coder/contracts';
import { z } from 'zod';
import { redactSecrets } from './secret-redactor';

export const PROJECT_MEMORY_MCP_GUIDANCE = `このTaskはProjectに所属しています。
今後のTurnでも役立つ安定した情報を新しく得た場合だけ、project_memory_rememberを使って自分で記憶してください。
保存対象は、ユーザーが明示した継続的な好み・決定、検証済みのrepository知識、再利用できる失敗原因と修正、成功した検証手順です。
短い雑談、一時的な進捗、未確認の推測、秘密、認証情報、会話履歴を読めば分かるだけの内容は保存しません。
内容は将来単独で読んでも分かる簡潔な事実として書き、同じ内容を重複保存しません。1 Turnにつき最大3件です。
ツールのqueuedは候補受付を意味し、Turnが正常完了した後にだけProject Memoryとして確定します。`;

export const PROJECT_MEMORY_PROVIDER_TOOL: ProviderTool = {
  name: 'project_memory_remember',
  description:
    'Queue one durable, self-contained Project memory candidate. It is committed only after this Turn completes successfully.',
  inputSchema: {
    type: 'object',
    properties: { content: { type: 'string', minLength: 1, maxLength: 4000 } },
    required: ['content'],
    additionalProperties: false,
  },
};

export type PendingProjectMemory = Readonly<{ projectId: string; content: string }>;

export function parseProjectMemoryCandidate(input: unknown): string {
  const { content } = z
    .object({ content: z.string().trim().min(1).max(4000) })
    .strict()
    .parse(input);
  if (redactSecrets(content) !== content)
    throw new Error('秘密を含む内容はProject Memoryへ保存できません');
  return content;
}

export function appendProjectMemoryCandidate(
  pending: readonly PendingProjectMemory[],
  candidate: PendingProjectMemory,
): PendingProjectMemory[] {
  if (pending.some(({ content }) => content === candidate.content)) return [...pending];
  if (pending.length >= 3) throw new Error('1 TurnのProject Memory候補は3件までです');
  return [...pending, candidate];
}
