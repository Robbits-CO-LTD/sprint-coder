import { win32 } from 'node:path';

// Main measurement input, never an operation's self-declared effect. P5 binds this to the
// observed item and input point; missing or ambiguous measurements remain closed.
export type WindowsExplorerOperation = Readonly<{
  verb: string;
  point?: Readonly<{ x: number; y: number }>;
  item?: Readonly<{ path: string; kind: string; surface: string }>;
}>;
// Case-insensitive only for ASCII letters. NTFS folds case with its own upcase table, which is not
// JavaScript's Unicode folding (toLowerCase maps U+212A KELVIN SIGN to "k", for example), so any
// non-ASCII character must match exactly. A non-ASCII case difference is refused, never over-matched.
function sameWindowsPathAscii(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    let a = left.charCodeAt(index);
    let b = right.charCodeAt(index);
    if (a >= 0x61 && a <= 0x7a) a -= 0x20;
    if (b >= 0x61 && b <= 0x7a) b -= 0x20;
    if (a !== b) return false;
  }
  return true;
}
// The item must be a direct child of the measured folder: what the file list of that view shows.
export function windowsExplorerItemInView(path: string, folder: string): boolean {
  if (
    !/^[a-z]:\\[^:*?"<>|/]*$/iu.test(folder) ||
    folder
      .split('\\')
      .slice(1)
      .some(
        (part, index, parts) =>
          (!part && index !== parts.length - 1) ||
          part === '.' ||
          part === '..' ||
          /[. ]$/u.test(part),
      )
  )
    return false;
  if (!/^[a-z]:\\[^*?"<>|/]+$/iu.test(path)) return false;
  const name = win32.basename(path);
  // ':' in the name addresses an alternate data stream, not a child item.
  if (!name || name.includes(':') || name === '.' || name === '..' || /[. ]$/u.test(name))
    return false;
  const measured = folder.length > 3 && folder.endsWith('\\') ? folder.slice(0, -1) : folder;
  if (path !== win32.join(win32.dirname(path), name)) return false;
  return sameWindowsPathAscii(win32.dirname(path), measured);
}
export function classifyWindowsExplorerOperation(
  operation: WindowsExplorerOperation,
): 'ordinary' | 'document_open' | 'executable_open' | 'command_surface' | 'unknown' {
  const item = operation.item;
  if (item?.surface === 'address_bar' || item?.surface === 'search_box') return 'command_surface';
  if (
    !item ||
    item.surface !== 'file_list' ||
    !/^[a-z]:\\[^:*?"<>|]+$/iu.test(item.path) ||
    item.path
      .split('\\')
      .some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part))
  )
    return 'unknown';
  // A folder named "x.{CLSID}" is a shell junction: Explorer opens it as that namespace (Control
  // Panel and the like), not as a file-system folder.
  if (item.path.split('\\').some((part) => /\.\{[0-9a-f-]{36}\}$/iu.test(part))) return 'unknown';
  const extension = win32.extname(item.path).toLowerCase();
  if (
    /^\.(?:exe|msi|bat|cmd|ps1|vbs|js|wsf|lnk|url|scf|cpl|msc|appref-ms|com|pif|scr)$/u.test(
      extension,
    )
  )
    return 'executable_open';
  // Only selecting or opening a measured folder is ordinary in this preparation.
  if (item.kind === 'folder' && (operation.verb === 'select' || operation.verb === 'open'))
    return 'ordinary';
  if (
    item.kind === 'file' &&
    operation.verb === 'open' &&
    /^\.(?:txt|md|log|csv|json|xml|pdf|png|jpg|jpeg|gif|bmp|webp|docx|xlsx|pptx|rtf)$/u.test(
      extension,
    )
  )
    return 'document_open';
  return 'unknown';
}
