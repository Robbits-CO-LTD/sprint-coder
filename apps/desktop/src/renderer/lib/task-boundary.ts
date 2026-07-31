export function allowTaskBoundary(editorDirty: boolean, confirmDiscard: () => boolean): boolean {
  return !editorDirty || confirmDiscard();
}
