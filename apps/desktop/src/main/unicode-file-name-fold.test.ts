import { expect, it } from 'vitest';
import { foldUnicodeFileName } from './unicode-file-name-fold';

it('uses default full Unicode folding without merging Turkic dotless i', () => {
  expect(foldUnicodeFileName('I.txt')).toBe(foldUnicodeFileName('i.txt'));
  expect(foldUnicodeFileName('i.txt')).not.toBe(foldUnicodeFileName('ı.txt'));
  expect(foldUnicodeFileName('İ.txt')).toBe(foldUnicodeFileName('i\u0307.txt'));
  expect(foldUnicodeFileName('İ.txt')).not.toBe(foldUnicodeFileName('i.txt'));
  expect(foldUnicodeFileName('Straße')).toBe(foldUnicodeFileName('STRASSE'));
  expect(foldUnicodeFileName('ΟΣ')).toBe(foldUnicodeFileName('οσ'));
  expect(foldUnicodeFileName('É')).toBe(foldUnicodeFileName('e\u0301'));
  expect(foldUnicodeFileName('ﬃ')).toBe(foldUnicodeFileName('FFI'));
});
