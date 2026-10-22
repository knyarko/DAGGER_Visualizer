/**
 * Theme — dark on open, light as a first-class switch.
 *
 * THE RESOLUTION ORDER, and it is not negotiable:
 *   1. localStorage['dagger.graphchat.theme'] -> 'dark' | 'light'  (the viewer chose)
 *   2. prefers-color-scheme                    -> only if nothing is stored
 *   3. 'dark'                                  -> the default, if both are silent
 *
 * WHERE THE FIRST RESOLUTION HAPPENS, and why it is not here. The resolved
 * value is written to <html data-theme="..."> by a BLOCKING INLINE SCRIPT in
 * the document head, before the first paint. A theme applied after hydration
 * is a white flash on every load for every dark-theme viewer, and that is a
 * design requirement rather than a performance nicety. A module cannot do it:
 * the app's entry is a deferred module script, which runs after the document
 * has been parsed and may be painted.
 *
 * So the same three-step order exists in exactly two places — the inline boot
 * script in `index.html` and this module — and the storage key below is the
 * seam between them. The key is a literal in both and must stay identical.
 * This module never RE-resolves on load; it reads what the boot script already
 * wrote off the root element, so the two cannot disagree about what is on
 * screen.
 *
 * localStorage can throw in a private window. Every access here is wrapped;
 * on a throw the theme still changes for the session and the control still
 * works — `persist` just reports that it did not stick.
 */

export type GraphChatTheme = 'dark' | 'light';

/** The seam with the boot script in `index.html`. Change both or neither. */
export const THEME_STORAGE_KEY = 'dagger.graphchat.theme';

export const DEFAULT_THEME: GraphChatTheme = 'dark';

function isTheme(value: unknown): value is GraphChatTheme {
  return value === 'dark' || value === 'light';
}

/**
 * What is on screen right now, read off <html data-theme>. The boot script put
 * it there before first paint; if for any reason it did not run, the default
 * answers, which is the same answer the boot script would have reached when
 * storage and the media query are both silent.
 */
export function currentTheme(): GraphChatTheme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const attr = document.documentElement.getAttribute('data-theme');
  return isTheme(attr) ? attr : DEFAULT_THEME;
}

/**
 * Put a theme on screen. Writes the attribute AND the CSS `color-scheme`, so
 * form controls, scrollbars and the caret follow the theme instead of staying
 * light — the same two writes the boot script makes.
 *
 * Returns whether the choice was persisted. `false` means localStorage refused
 * (a private window), the theme changed anyway, and the caller is expected to
 * say so in one quiet line rather than silently losing the setting.
 */
export function applyTheme(theme: GraphChatTheme): boolean {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}
