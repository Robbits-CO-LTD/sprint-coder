// CameraDirector ownership (Slice 6.3 item 2): pure state transition, unit-testable without a
// DOM/React tree. Ownership starts 'system'. ANY manual input (canvas pan start, wheel zoom, node
// drag start) and explicit Fit view/F claim 'user' — useCamera also cancels whatever
// system animation is in flight at that moment, so the viewport freezes exactly where it is (docs
// §4.6: "user inputで自動animationをcancelし、そのviewportを維持"). While ownership is 'user',
// every automatic move (spawn-follow, scheduleFit, the saved-view redirect, ...) must check
// `shouldRunAutomaticMove` itself and no-op. Explicit focus commands (Leaderへ,
// Enter-focus on a selected node, keyboard l) always execute and hand ownership back to
// 'system' regardless of the current owner — entering the canvas (seed-then-fly) never has to
// claim anything since a freshly mounted camera already starts 'system'.
export type CameraOwner = 'system' | 'user';
export type CameraOwnershipEvent = 'manual-input' | 'explicit-command';

export function nextCameraOwner(_current: CameraOwner, event: CameraOwnershipEvent): CameraOwner {
  return event === 'manual-input' ? 'user' : 'system';
}

export function shouldRunAutomaticMove(owner: CameraOwner): boolean {
  return owner === 'system';
}
