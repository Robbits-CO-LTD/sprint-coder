export type ComputerUseEligibilityBuildMode = 'v1-allowlist' | 'v2-denylist';
export type ComputerUseEligibilityBuildDeclaration = {
  mode: ComputerUseEligibilityBuildMode;
  rulesetVersion: number;
  classifierVersion: number;
  lexiconVersion: number;
  ticketRequired: boolean;
};
export function parseEligibilityMode(
  argv: readonly string[],
  target: string,
): ComputerUseEligibilityBuildMode;
export function eligibilityDeclaration(
  mode: string,
  platform: string,
): ComputerUseEligibilityBuildDeclaration;
export function eligibilityBuildHeader(declaration: ComputerUseEligibilityBuildDeclaration): string;
