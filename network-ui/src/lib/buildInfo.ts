// Build metadata injected at build time by the GitHub Pages workflow via
// VITE_* env vars (Vite auto-exposes anything prefixed `VITE_`). In local
// `npm run dev`, neither is set, so we fall back to a recognisable "dev"
// marker — helpful for distinguishing "am I on prod or my local server?".

const RAW_SHA = (import.meta.env.VITE_BUILD_SHA as string | undefined) ?? '';
const RAW_TIME = (import.meta.env.VITE_BUILD_TIME as string | undefined) ?? '';

export const BUILD_SHA = RAW_SHA ? RAW_SHA.slice(0, 7) : 'dev';
export const BUILD_SHA_FULL = RAW_SHA || 'dev';
export const BUILD_TIME = RAW_TIME;

export function buildLabel(): string {
  if (!RAW_SHA) return 'dev';
  if (!RAW_TIME) return `build ${BUILD_SHA}`;
  // Compact "MMM D HH:MM" for the visible label; full ISO available on hover.
  const d = new Date(RAW_TIME);
  if (Number.isNaN(d.getTime())) return `build ${BUILD_SHA}`;
  const parts = d.toUTCString().split(' ');
  // e.g. "Wed, 05 Jun 2026 14:20:33 GMT" → "Jun 5 · 14:20"
  return `${BUILD_SHA} · ${parts[2]} ${parseInt(parts[1])} ${parts[4].slice(0, 5)} UTC`;
}
