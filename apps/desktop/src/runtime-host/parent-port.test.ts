import { describe, expect, it } from 'vitest';
import { requireParentPort } from './parent-port';

describe('Runtime Host parent port', () => {
  it('uses the port Electron exposes on the utility process global', () => {
    const port = {} as Electron.ParentPort;
    expect(requireParentPort({ parentPort: port })).toBe(port);
  });

  it('fails explicitly outside an Electron UtilityProcess', () => {
    expect(() => requireParentPort({})).toThrow(
      'Runtime Host must run inside an Electron UtilityProcess',
    );
  });
});
