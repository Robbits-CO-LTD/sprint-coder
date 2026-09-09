export function codexManagedToolName(providerName: string): string {
  // Distinguish the host's approved command tools from disabled Codex native shell tools.
  // Calls are mapped back to the pinned catalog name before the host validates/authorizes them.
  return providerName === 'exec_command' || providerName === 'write_stdin'
    ? `sprint_${providerName}`
    : providerName;
}
