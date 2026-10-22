/**
 * The theme control — two options, both always visible, both always labelled in
 * WORDS.
 *
 * Not an icon toggle. A single sun/moon glyph makes a viewer guess whether it
 * shows the current state or the thing it will switch to, and half of them
 * guess wrong. Two labelled options have no such question in them.
 *
 * The native radio pattern: `role="radiogroup"` with two `role="radio"`
 * children, arrow keys to move, Space to select, and a roving tabindex so the
 * group is one tab stop.
 *
 * The switch NEVER reloads, never re-asks and never re-runs a query. Answers
 * already on screen re-paint in place from the other theme's own tokens, and
 * the full retained set is untouched. There is no transition on the swap: a
 * 180ms cross-fade of an entire theme reads as a bug.
 *
 * It is never disabled. A theme control is never unavailable.
 */

import { useRef } from 'react';
import type { GraphChatTheme } from './theme';

export interface ThemeControlProps {
  theme: GraphChatTheme;
  onChange: (theme: GraphChatTheme) => void;
  /** False after a localStorage write threw — a private window. The theme still
   *  changed for the session and the control still works; this is the one quiet
   *  line that says it will not be remembered. */
  persisted: boolean;
}

const OPTIONS: ReadonlyArray<{ value: GraphChatTheme; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export default function ThemeControl({ theme, onChange, persisted }: ThemeControlProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (delta: number) => {
    const index = OPTIONS.findIndex(o => o.value === theme);
    const next = (index + delta + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div>
      <div className="gc-theme">
        <span className="gc-theme-label" id="gc-theme-label">
          Theme
        </span>
        <div className="gc-theme-track" role="radiogroup" aria-labelledby="gc-theme-label">
          {OPTIONS.map((option, i) => {
            const selected = option.value === theme;
            return (
              <button
                key={option.value}
                type="button"
                ref={element => {
                  refs.current[i] = element;
                }}
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className="gc-theme-opt"
                onClick={() => onChange(option.value)}
                onKeyDown={event => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    move(1);
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    move(-1);
                  } else if (event.key === ' ') {
                    event.preventDefault();
                    onChange(option.value);
                  }
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      {!persisted && (
        <div className="gc-theme-note">this choice will not be remembered in a private window</div>
      )}
    </div>
  );
}
