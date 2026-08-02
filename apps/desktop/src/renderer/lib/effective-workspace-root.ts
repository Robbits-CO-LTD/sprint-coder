type WorkspacePath = Readonly<{ path: string }> | null | undefined;

/** Mirrors Main's effective Workspace fallback without treating a loaded `null` as a root. */
export function hasEffectiveWorkspaceRoot(
  workspace: WorkspacePath,
  legacyTaskPath: string | null | undefined,
  projectFolderCount: number | undefined,
): boolean {
  return Boolean(workspace?.path || legacyTaskPath || (projectFolderCount ?? 0) > 0);
}
