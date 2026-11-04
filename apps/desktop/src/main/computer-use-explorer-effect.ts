import { win32 } from 'node:path';

// Main measurement input, never an operation's self-declared effect. P5 binds this to the
// observed item and input point; missing or ambiguous measurements remain closed.
export type WindowsExplorerOperation = Readonly<{
  verb: string;
  item?: Readonly<{ path: string; kind: string; surface: string }>;
}>;
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
