export function goalResumeText(objective: string): string {
  // Keep the Goal's first Markdown block separate from the continuation directive.
  return `Goalを続けてください:\n\n${objective}`;
}
