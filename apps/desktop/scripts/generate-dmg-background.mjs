import { resolve } from 'node:path';
import sharp from 'sharp';

const desktopRoot = resolve(import.meta.dirname, '..');
const source = resolve(desktopRoot, 'assets', 'dmg-background.svg');

await Promise.all([
  sharp(source)
    .resize(658, 498)
    .png({ compressionLevel: 9 })
    .toFile(resolve(desktopRoot, 'assets', 'dmg-background.png')),
  sharp(source)
    .resize(1316, 996)
    .png({ compressionLevel: 9 })
    .toFile(resolve(desktopRoot, 'assets', 'dmg-background@2x.png')),
]);

console.log('Generated DMG backgrounds at 658x498 and 1316x996.');
