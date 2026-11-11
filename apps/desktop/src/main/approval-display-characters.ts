/**
 * Characters the card would not show as themselves, so the person would approve text they did not
 * read. Control characters (other than tab, line feed, and carriage return) and format characters
 * draw as nothing or reorder what is drawn; line and paragraph separators, private-use, and
 * unassigned codepoints have no reliable glyph.
 *
 * `\p{Cf}` rather than a hand-picked list: the Unicode Tag block (U+E0000-U+E007F) spells a whole
 * sentence in invisible codepoints, which would then sit in Project memory and be read by every
 * later Turn, and a single U+200B inside a token is enough to hide it from the secret scanner. ZWJ
 * is a format character, so an emoji joined by it is refused, which is accepted.
 *
 * Combining marks as a whole stay allowed, since NFD Japanese depends on them.
 * The ones that never draw are refused through Unicode's Default_Ignorable_Code_Point rather than a
 * list of names, which kept missing some (the Khmer inherent vowels U+17B4 and U+17B5, for one):
 * each hides a token from the secret scanner as U+200B does, and a run of variation selectors
 * carries one byte apiece. Only the two a card needs to draw are allowed, and only where they draw
 * something. U+FE0E or U+FE0F must follow an emoji and choose its form, and after a keycap base
 * (0-9, #, *) only as part of a keycap with U+20E3; anywhere else it draws nothing, so it could
 * split a secret or carry one bit per character. One ideographic variation selector may follow a
 * Han character, which Japanese names need. Either repeated, or out of those places, is refused.
 */
export const APPROVAL_DISPLAY_UNDISPLAYABLE_CHARACTERS =
  /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]|(?![\t\n\r])\p{Cc}|(?![\uFE0E\uFE0F\u{E0100}-\u{E01EF}])\p{Default_Ignorable_Code_Point}|(?<=[\uFE00-\uFE0F\u{E0100}-\u{E01EF}])[\uFE0E\uFE0F]|(?<!\p{Emoji})[\uFE0E\uFE0F]|(?<=[0-9#*])[\uFE0E\uFE0F](?!\u20E3)|(?<!\p{Script=Han})[\u{E0100}-\u{E01EF}]/u;
