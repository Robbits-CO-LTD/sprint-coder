/**
 * Prefix that makes Codex actually invoke its image generator (issue #11).
 *
 * `$imagegen` is the documented way to force the tool. The "do not copy" clause is not decoration:
 * the CLI's generator writes the PNG to its own directory outside the sandbox, and the model then
 * tries to `cp` it into the workspace. Under `--sandbox read-only` that copy simply fails and the
 * final message reads "画像は生成できましたが…コピーできませんでした" — a misleading failure report for
 * an image that does exist. Since issue #37 the sandbox can also be `workspace-write`, where the
 * copy would instead succeed and leave a stray PNG in the user's repository that they never asked
 * for. Both outcomes are wrong, and the same clause avoids both: Main takes custody of the file
 * from the generator's own directory either way. Verified against codex-cli 0.144.4.
 *
 * Lives in its own module because both the Composer (which prepends it) and the Timeline (which
 * detects an unfulfilled request from it) need the exact same string — two copies would silently
 * stop matching.
 */
export const IMAGEGEN_PREFIX =
  '$imagegen 画像を生成してください。生成のみで、ファイルのコピーや移動は行わないでください。依頼:';
