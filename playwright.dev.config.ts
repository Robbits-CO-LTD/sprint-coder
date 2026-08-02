import { createPlaywrightConfig } from './playwright.base';

process.env['SPRINT_CODER_E2E_MODE'] = 'dev';

export default createPlaywrightConfig();
