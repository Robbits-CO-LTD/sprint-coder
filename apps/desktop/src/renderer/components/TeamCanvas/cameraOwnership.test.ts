import { describe, expect, it } from 'vitest';
import { nextCameraOwner, shouldRunAutomaticMove } from './cameraOwnership';
import type { CameraOwner } from './cameraOwnership';

describe('CameraDirector ownership transitions', () => {
  it('starts able to run automatic moves (system-owned)', () => {
    expect(shouldRunAutomaticMove('system')).toBe(true);
  });

  it('manual input claims user ownership regardless of the current owner', () => {
    expect(nextCameraOwner('system', 'manual-input')).toBe('user');
    expect(nextCameraOwner('user', 'manual-input')).toBe('user');
  });

  it('an explicit command always hands ownership back to system', () => {
    expect(nextCameraOwner('user', 'explicit-command')).toBe('system');
    expect(nextCameraOwner('system', 'explicit-command')).toBe('system');
  });

  it('automatic moves are blocked once the user owns the camera', () => {
    const owner: CameraOwner = nextCameraOwner('system', 'manual-input');
    expect(shouldRunAutomaticMove(owner)).toBe(false);
  });

  it('automatic moves resume once an explicit command returns ownership', () => {
    let owner: CameraOwner = 'system';
    owner = nextCameraOwner(owner, 'manual-input');
    expect(shouldRunAutomaticMove(owner)).toBe(false);
    owner = nextCameraOwner(owner, 'explicit-command');
    expect(shouldRunAutomaticMove(owner)).toBe(true);
  });
});
