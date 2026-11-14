import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './fonts.css';
import {
  applyPlatformClass,
  STARTUP_FONT_SPECS,
  STARTUP_FONT_WAIT_MS,
  waitForFonts,
} from './lib/fonts';

const root = document.getElementById('root');
if (root === null) throw new Error('Renderer root element is missing');

const platform = window.sprintCoder?.windowControls?.platform;
applyPlatformClass(document.documentElement, platform);

// The faces use `font-display: block`, so text is never drawn in another font first. Waiting for
// them here (briefly) also keeps the first frame from being blank text.
void waitForFonts(document.fonts, STARTUP_FONT_SPECS, STARTUP_FONT_WAIT_MS).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
