import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QA_1413_PROFILE, qa1413FixtureSchema } from '../qa-1413';

export function loadQa1413Session(appPath: string) {
  const base = join(appPath, QA_1413_PROFILE);
  const profile = join(base, 'profile');
  const skillHome = join(base, 'skill-home');
  for (const path of [base, profile, skillHome]) {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error('QA #1413 requires the isolated fixture created by its seed script.');
  }
  for (const path of [join(base, 'session.json'), join(profile, 'sprint-coder.sqlite3')]) {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)
      throw new Error('QA #1413 fixture files must be local to the isolated profile.');
  }
  const fixture = qa1413FixtureSchema.parse(
    JSON.parse(readFileSync(join(base, 'session.json'), 'utf8')),
  );
  return { profile, skillHome, fixture };
}
