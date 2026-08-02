import { acquireWindowsAclProcessLock, secureWindowsPath } from './windows-acl';

const path = process.argv[2];
if (path === undefined) throw new Error('Expected a file path');

if (path === '--hold-lock') {
  await acquireWindowsAclProcessLock();
  process.stdout.write('locked\n');
} else {
  await secureWindowsPath(path, 'file');
}
