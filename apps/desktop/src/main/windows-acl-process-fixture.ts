import { secureWindowsPath } from './windows-acl';

const path = process.argv[2];
if (path === undefined) throw new Error('Expected a file path');

await secureWindowsPath(path, 'file');
