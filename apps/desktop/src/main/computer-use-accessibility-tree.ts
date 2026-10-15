import { createHash } from 'node:crypto';
import { COMPUTER_USE_LIMITS } from '@sprint-coder/contracts';

const REDACTED_ACCESSIBILITY_TEXT = '[redacted]';
export const COMPUTER_USE_ACCESSIBILITY_POLICY_VERSION = 1 as const;
const BOUNDED_PAYMENT_TEXT =
  /(?:^|[^\p{L}\p{N}])(?:pay(?:[\s_-]+now)?|place[\s_-]+order|submit[\s_-]+order|complete[\s_-]+order|buy[\s_-]+now|pagar|comprar|acheter|bestellen|bezahlen|pagare|acquistare|betalen|kopen)(?=$|[^\p{L}\p{N}])/iu;
const HIGH_IMPACT_TEXT =
  /(payment|purchase|checkout|contract|agreement|install|administrator|security|password|credential|\bterminal\b|\bshell\b|command prompt|powershell|\bconsole\b|決済|支払い|支払う|購入|注文を確定|注文する|請求|送金|契約|インストール|管理者|セキュリティ|パスワード|ターミナル|シェル)/iu;
/**
 * Structure words of a command surface (a terminal, a shell, the command palette). Matched against
 * the role, subrole and identifier only (never a title, description or value), as whole words after
 * splitting on non-alphanumerics and camelCase, so 'terminalPanel' and 'integrated-terminal' match
 * and 'terminalbank' or 'app-shell' do not. Main's own, native-independent evidence for the S4-1c
 * deny: a positive match only. An element without such a word is never a surface here (native and
 * v1 still judge it).
 */
const SURFACE_WORDS = new Set(['terminal', 'xterm', 'powershell', 'pwsh', 'commandpalette']);

export function hasSurfaceStructureWord(...fields: readonly (string | undefined)[]): boolean {
  for (const field of fields) {
    if (field === undefined || field === '') continue;
    const words = field
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== '');
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      if (SURFACE_WORDS.has(word)) return true;
      if (word === 'command' && words[index + 1] === 'palette') return true;
      if (word === 'power' && words[index + 1] === 'shell') return true;
    }
  }
  return false;
}
const SECURE_ROLES = new Set(['AXSecureTextField', 'AXPasswordField']);
const OPTIONAL_TEXT_FIELDS = ['subrole', 'value', 'description', 'help', 'placeholder'] as const;
const TREE_NODE_KEYS = new Set([
  'role',
  'title',
  'identifier',
  'children',
  ...OPTIONAL_TEXT_FIELDS,
]);

type ProjectedTreeNode = Readonly<{
  role: string;
  subrole?: string;
  title: string;
  identifier: string;
  value?: string;
  description?: string;
  help?: string;
  placeholder?: string;
  children: readonly ProjectedTreeNode[];
}>;

export type ComputerUseAccessibilityTreeProjection = Readonly<{
  serialized: string;
  digest: string;
  byteLength: number;
  depth: number;
  nodeCount: number;
  signatures: Readonly<Record<string, string>>;
  metadata: Readonly<
    Record<string, Readonly<{ secure: boolean; highImpact: boolean; surface?: boolean }>>
  >;
}>;

export class ComputerUseAccessibilityTreeError extends Error {
  constructor(readonly code: 'tree_invalid' | 'tree_oversized') {
    super(`Computer Use accessibility tree is invalid: ${code}`);
    this.name = 'ComputerUseAccessibilityTreeError';
  }
}

/**
 * Convert an OS accessibility tree into the only representation allowed to leave Main.
 * Raw text is inspected once to derive restrictive policy facts. Sensitive target text is then
 * replaced before the digest and byte metadata are computed, so those facts always describe the
 * exact projection sent to a Provider.
 */
export function projectComputerUseAccessibilityTree(
  tree: string,
): ComputerUseAccessibilityTreeProjection {
  const inputBytes = Buffer.byteLength(tree, 'utf8');
  if (inputBytes === 0) throw new ComputerUseAccessibilityTreeError('tree_invalid');
  if (inputBytes > COMPUTER_USE_LIMITS.maxTreeBytes)
    throw new ComputerUseAccessibilityTreeError('tree_oversized');

  let decoded: unknown;
  try {
    decoded = JSON.parse(tree) as unknown;
  } catch {
    throw new ComputerUseAccessibilityTreeError('tree_invalid');
  }

  const signatures: Record<string, string> = Object.create(null) as Record<string, string>;
  const metadata: Record<string, { secure: boolean; highImpact: boolean; surface?: boolean }> =
    Object.create(null) as Record<
      string,
      { secure: boolean; highImpact: boolean; surface?: boolean }
    >;
  const duplicates = new Set<string>();
  let nodeCount = 0;
  let maximumDepth = 0;

  const visit = (
    value: unknown,
    depth: number,
    ancestors: readonly string[],
    inSurface: boolean,
  ): ProjectedTreeNode => {
    if (depth > COMPUTER_USE_LIMITS.maxTreeDepth)
      throw new ComputerUseAccessibilityTreeError('tree_invalid');
    nodeCount += 1;
    if (nodeCount > COMPUTER_USE_LIMITS.maxTreeNodes)
      throw new ComputerUseAccessibilityTreeError('tree_invalid');
    maximumDepth = Math.max(maximumDepth, depth);

    const node = parseTreeNode(value);
    const role = node.role;
    const subrole = node.optionalText.subrole;
    const secure = SECURE_ROLES.has(role) || (subrole !== undefined && SECURE_ROLES.has(subrole));
    const policyText = [node.identifier, node.title, ...Object.values(node.optionalText)].join(
      '\n',
    );
    const highImpact = HIGH_IMPACT_TEXT.test(policyText) || BOUNDED_PAYMENT_TEXT.test(policyText);
    const sensitive = secure || highImpact;
    // A surface word on this element or on any ancestor (a terminal panel holds its own children).
    const surface = inSurface || hasSurfaceStructureWord(role, subrole, node.identifier);
    const targetId = node.identifier || node.title;
    if (targetId !== '' && targetId.length <= 128) {
      if (Object.hasOwn(signatures, targetId)) duplicates.add(targetId);
      else {
        signatures[targetId] = sha256(
          JSON.stringify({
            policyVersion: COMPUTER_USE_ACCESSIBILITY_POLICY_VERSION,
            role,
            identifier: node.identifier,
            ancestors: [...ancestors, role],
          }),
        );
        metadata[targetId] = { secure, highImpact, ...(surface ? { surface: true } : {}) };
      }
    }

    const optionalText = Object.fromEntries(
      Object.entries(node.optionalText).map(([key, text]) => [
        key,
        key !== 'subrole' && sensitive ? REDACTED_ACCESSIBILITY_TEXT : text,
      ]),
    ) as Pick<ProjectedTreeNode, 'subrole' | 'value' | 'description' | 'help' | 'placeholder'>;
    return Object.freeze({
      role,
      ...optionalText,
      title: sensitive ? REDACTED_ACCESSIBILITY_TEXT : node.title,
      identifier: sensitive ? REDACTED_ACCESSIBILITY_TEXT : node.identifier,
      children: Object.freeze(
        node.children.map((child) => visit(child, depth + 1, [...ancestors, role], surface)),
      ),
    });
  };

  const projected = visit(decoded, 0, [], false);
  for (const duplicate of duplicates) {
    delete signatures[duplicate];
    delete metadata[duplicate];
  }
  const serialized = JSON.stringify(projected);
  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > COMPUTER_USE_LIMITS.maxTreeBytes)
    throw new ComputerUseAccessibilityTreeError('tree_oversized');

  return Object.freeze({
    serialized,
    digest: sha256(serialized),
    byteLength,
    depth: maximumDepth,
    nodeCount,
    signatures: Object.freeze(signatures),
    metadata: Object.freeze(metadata),
  });
}

function parseTreeNode(value: unknown): Readonly<{
  role: string;
  title: string;
  identifier: string;
  optionalText: Readonly<Partial<Record<(typeof OPTIONAL_TEXT_FIELDS)[number], string>>>;
  children: readonly unknown[];
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComputerUseAccessibilityTreeError('tree_invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !TREE_NODE_KEYS.has(key)))
    throw new ComputerUseAccessibilityTreeError('tree_invalid');
  if (
    typeof record['role'] !== 'string' ||
    typeof record['title'] !== 'string' ||
    typeof record['identifier'] !== 'string' ||
    !Array.isArray(record['children']) ||
    record['role'].length > 256 ||
    record['title'].length > 256 ||
    record['identifier'].length > 256
  )
    throw new ComputerUseAccessibilityTreeError('tree_invalid');

  const optionalText: Partial<Record<(typeof OPTIONAL_TEXT_FIELDS)[number], string>> = {};
  for (const field of OPTIONAL_TEXT_FIELDS) {
    const text = record[field];
    if (text === undefined) continue;
    if (typeof text !== 'string' || text.length > 4_096)
      throw new ComputerUseAccessibilityTreeError('tree_invalid');
    optionalText[field] = text;
  }
  return {
    role: record['role'],
    title: record['title'],
    identifier: record['identifier'],
    optionalText,
    children: record['children'],
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
