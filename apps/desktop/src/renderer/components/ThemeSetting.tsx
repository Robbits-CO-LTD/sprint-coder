import { THEME_ATTRIBUTE, THEMES, type ThemeId } from '../../window-theme';
import { setTheme, useTheme } from '../lib/theme';
import { Check } from './icons';

/**
 * Settings' 「テーマ」: the themes side by side, each as a small picture of the window in its own
 * colours. Choosing one recolours the whole window at once; Main keeps the choice for the next
 * launch (lib/theme.ts).
 *
 * The choices are native radio buttons, so the arrow keys move between them and a screen reader
 * hears "テーマ, 黒, 1 of 3" without anything added. The pictures say nothing a name does not.
 */
export function ThemeSetting() {
  const theme = useTheme();
  return (
    <fieldset className="settings-group theme-setting" data-testid="settings-theme">
      <legend>テーマ</legend>
      <div className="theme-options">
        {THEMES.map(({ id, label }) => (
          <label key={id} className="theme-option">
            <input
              type="radio"
              name="settings-theme"
              value={id}
              checked={theme === id}
              data-testid={`settings-theme-${id}`}
              onChange={() => setTheme(id)}
            />
            <span className="theme-option-frame">
              <ThemePreview theme={id} />
            </span>
            <span className="theme-option-name">
              {label}
              <Check size={13} />
            </span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        選ぶとすぐに切り替わります。次に開いた時も、同じテーマで始まります。
      </p>
    </fieldset>
  );
}

/** The window in miniature: the Task list, a conversation and the composer. It carries the theme's
 * own `data-theme`, so every colour in it is that theme's real variable, not a copy of it. */
function ThemePreview({ theme }: { theme: ThemeId }) {
  return (
    <span className="theme-preview" aria-hidden="true" {...{ [THEME_ATTRIBUTE]: theme }}>
      <span className="theme-preview-side">
        <i />
        <i className="is-current" />
        <i />
        <i />
      </span>
      <span className="theme-preview-main">
        <i className="theme-preview-ask" />
        <i className="theme-preview-line" />
        <i className="theme-preview-line" />
        <i className="theme-preview-card" />
        <span className="theme-preview-composer">
          <i />
        </span>
      </span>
    </span>
  );
}
