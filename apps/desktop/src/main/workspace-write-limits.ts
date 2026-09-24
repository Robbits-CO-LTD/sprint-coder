// Windows の NativeSafeFs アドオンは常に mutationScope='add-only'・directoryOwnership=false を返す
// (native-safe-fs-win-mutation.cc)。そのため Windows では、書き込み可能な Team Worker でも新しい
// ファイルの作成しかできず、既存ファイルの編集・削除やフォルダの作成ができない（Issue #542）。この
// 制限そのものを直す対応は別Issue（#559）に分け、ここでは Worker の指示文と割り当て結果へその制限
// を日本語で伝えるための純粋関数だけを置く。

/** Worker が実際にできる Workspace 書き込み操作。両方 true なら制限は無い。 */
export type WorkspaceWriteLimits = Readonly<{
  editExisting: boolean;
  createDirectory: boolean;
}>;

const CREATE_FILE_TOOL_NAME = 'create_file';
const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const CREATE_DIRECTORY_TOOL_NAME = 'create_directory';

/**
 * Worker へ実際に渡したツール名の集合から限界を導く。`create_file` が無いときは、管理ツールで一切
 * 書き込めない別の状態（write-not-attempted 等、既存の規則で扱う）なので対象外として null を返す。
 */
export function workspaceWriteLimitsFromTools(
  toolNames: Iterable<string>,
): WorkspaceWriteLimits | null {
  const names = new Set(toolNames);
  if (!names.has(CREATE_FILE_TOOL_NAME)) return null;
  return {
    editExisting: names.has(APPLY_PATCH_TOOL_NAME),
    createDirectory: names.has(CREATE_DIRECTORY_TOOL_NAME),
  };
}

/** The subset of WorkspacePatchDeps (provider-workspace-tools.ts) that decides tool registration. */
export type WorkspaceEditRegistrationFields = Readonly<{
  supportsPatch?: boolean;
  createDirectory?: unknown;
}>;

/**
 * `workspaceWriteLimitsFromTools` と同じ結論を、ツール登録前の WorkspacePatchDeps から直接導く。
 * provider-workspace-tools.ts の登録条件（apply_patch は supportsPatch !== false、
 * create_directory は createDirectory !== undefined のときだけ登録）と同じ規則を使う。
 */
export function workspaceWriteLimitsOf(
  edit: WorkspaceEditRegistrationFields | undefined,
): WorkspaceWriteLimits | null {
  if (edit === undefined) return null;
  return {
    editExisting: edit.supportsPatch !== false,
    createDirectory: edit.createDirectory !== undefined,
  };
}

function hasNoLimit(limits: WorkspaceWriteLimits | null): boolean {
  return limits === null || (limits.editExisting && limits.createDirectory);
}

function cannotList(limits: WorkspaceWriteLimits, joiner: 'と' | 'や'): string {
  const cannot: string[] = [];
  if (!limits.editExisting) cannot.push('既存ファイルの編集・削除');
  if (!limits.createDirectory) cannot.push('フォルダの作成');
  return cannot.join(joiner);
}

// The Windows reason is stated only for the add-only limit the Windows NativeSafeFs actually has;
// any other combination gets the general reason rather than a claim about new files only.
function writeLimitReason(limits: WorkspaceWriteLimits, platform: NodeJS.Platform): string {
  return platform === 'win32' && !limits.editExisting && !limits.createDirectory
    ? 'Windows では、安全に書き込める操作が今は新しいファイルの作成に限られるため'
    : 'この環境では、安全に書き込める操作が限られているため';
}

/**
 * Worker 自身の指示文へ、「Workspace書き込み: …」の行のすぐ後に入れる日本語の通知。制限が無い
 * （null、または既存編集とフォルダ作成の両方ができる）ときは空文字列。
 */
export function workerWriteLimitNotice(
  limits: WorkspaceWriteLimits | null,
  platform: NodeJS.Platform = process.platform,
): string {
  if (hasNoLimit(limits)) return '';
  const limitsChecked = limits as WorkspaceWriteLimits;
  return (
    `${writeLimitReason(limitsChecked, platform)}、${cannotList(limitsChecked, 'と')}はできません。` +
    (limitsChecked.createDirectory
      ? '新しいファイルは作れます。'
      : '新しいファイルは、既にあるフォルダの中だけに作れます。') +
    `${cannotList(limitsChecked, 'や')}が必要な部分は、別名のファイルを作って代わりにせず、` +
    'その部分は変えずに必要な変更内容を報告してください。'
  );
}

/**
 * 割り当て結果（team_assign_task/team_assign_mission）へ載せる、Leader/Manager 向けの日本語の
 * 注記。制限はホスト全体のもので、Mission の複数の Worker にも同じくかかるため、特定の Worker を
 * 指さない書き方にする。制限が無いときは空文字列。
 */
export function leaderWriteLimitNote(
  limits: WorkspaceWriteLimits | null,
  platform: NodeJS.Platform = process.platform,
): string {
  if (hasNoLimit(limits)) return '';
  const limitsChecked = limits as WorkspaceWriteLimits;
  return (
    `この環境のWorkerは${cannotList(limitsChecked, 'と')}ができません（${writeLimitReason(limitsChecked, platform)}）。` +
    `${cannotList(limitsChecked, 'や')}が必要な作業は、Workerに変更内容の報告を頼んでください。`
  );
}
