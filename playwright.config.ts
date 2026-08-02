import { createPlaywrightConfig } from './playwright.base';

// Playwright Electron E2E for sprint-coder (docs/PRODUCT_AND_TECHNICAL_DESIGN.md §15.5 golden
// paths). Targets the packaged production app (electron-forge package), never the `npm start`
// dev server. See tests/e2e/helpers.ts and tests/e2e/global-setup.ts.
export default createPlaywrightConfig();
