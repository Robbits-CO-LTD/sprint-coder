export const expectedEligibilityVersionTable = {
  darwin: {
    v1: { rulesetVersion: 1, classifierVersion: 1, lexiconVersion: 1 },
    v2: { rulesetVersion: 1, classifierVersion: 1, lexiconVersion: 1 },
  },
  win32: {
    v1: { rulesetVersion: 1, classifierVersion: 1, lexiconVersion: 1 },
    v2: { rulesetVersion: 4, classifierVersion: 3, lexiconVersion: 3 },
  },
};

export type EligibilityVersionTable = typeof expectedEligibilityVersionTable;
