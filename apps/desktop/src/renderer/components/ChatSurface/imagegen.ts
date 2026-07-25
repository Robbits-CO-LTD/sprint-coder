/**
 * Prefix that makes Codex actually invoke its image generator (issue #11).
 *
 * `$imagegen` is the documented way to force the tool. The "do not copy" clause is not decoration:
 * the CLI's generator writes the PNG to its own directory outside the sandbox, but the model then
 * tries to `cp` it into the workspace and fails — `--sandbox read-only` with
 * `shell_environment_policy.inherit="none"` leaves it without even a PATH, so the copy exits 127 and
 * the final message reads "画像は生成できましたが…コピーできませんでした". Telling it not to copy turns
 * a misleading failure report into a clean success, while the app takes custody of the file itself.
 * Verified against codex-cli 0.144.4.
 *
 * Lives in its own module because both the Composer (which prepends it) and the Timeline (which
 * detects an unfulfilled request from it) need the exact same string — two copies would silently
 * stop matching.
 */
export const IMAGEGEN_PREFIX =
  '$imagegen 画像を生成してください。生成のみで、ファイルのコピーや移動は行わないでください。依頼:';
