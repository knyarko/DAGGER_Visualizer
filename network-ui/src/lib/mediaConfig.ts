// network-ui/src/lib/mediaConfig.ts
//
// WHERE THE MEDIA LIVES.
//
// The folders themselves are listed in `mediaRoots.json`, beside this file.
// That JSON is the ONE thing a person edits. This module only reads it, checks
// it, and turns each entry into the same-origin prefix the browser asks for.
//
// ── NO URLs. AA050, and it is Rusty's own instruction ────────────────────────
//   "I thought I said put it in the config json to call. localhost is not
//    correct... We agreed upon setting a base url value that is an array that
//    holds both crisis path and 911 call path. NO htmls ever."
//   and, asked directly: "please make it work without use of urls."
//
//   So `mediaRoots.json` holds FILESYSTEM PATHS and nothing else. No scheme,
//   no host, no port, nothing to remember or type. The previous build put two
//   loopback addresses here and assumed a small static file server was running
//   beside the app. It was not, and it should not have to be — that is exactly
//   why every card read "File did not load".
//
// ── SO WHAT SERVES THE BYTES? ────────────────────────────────────────────────
//   A browser cannot read `C:\...` from a page, so something has to hand those
//   bytes over HTTP, and the thing already running is Vite. `vite.config.ts`
//   reads the SAME `mediaRoots.json` and mounts entry 0 at `/__media/0`, entry
//   1 at `/__media/1`, and so on. The page then fetches a same-origin path and
//   the config stays disk paths. No second server, and nothing for a person to
//   start by hand.
//
//   The mount prefix `/__media` is named in TWO places — here and in
//   `vite.config.ts`. They must agree; change one and change the other.
//
// ── WHY AN ARRAY ─────────────────────────────────────────────────────────────
//   The CrisisMMD images and the 911 call audio sit in different sections of
//   the tree, so one folder cannot reach both. Entries are tried IN ORDER and
//   the first that actually loads wins.
//
// ── HOW A ROOT AND A `media[].path` JOIN (the rule) ──────────────────────────
//   A DAGGER record's `media[].path` is relative to `crisis_triplets` and
//   already reads `resources/test_files/datasets/...`, while a configured root
//   may point deep into that same tree. Concatenating them would double the
//   middle.
//
//   The rule: **the root's tail and the path's head OVERLAP, they do not
//   concatenate.** The longest run of trailing segments the root already ends
//   with is consumed from the front of the path, and what is left is appended.
//   Candidates are tried longest-overlap-first and the first that exists on
//   disk wins, so a coincidental overlap cannot win over a real file.
//
//   The whole relative path is sent as-is in the URL; `vite.config.ts` does the
//   overlapping, because only the server can check what is actually on disk and
//   only the server can deal with `\` on Windows. Nothing here has to know the
//   shape of the paths in a graph file, and neither does a graph file have to
//   know the shape of a root. Both fixture shapes work unchanged:
//
//     root .../crisis_triplets            + resources/test_files/.../x.jpg  ✓
//     root .../Crisis_MMD_.../images      + resources/test_files/.../x.jpg  ✓
//     root .../Crisis_MMD_.../images      + x.jpg                           ✓
//
// ── WHEN IT DOES NOT WORK ────────────────────────────────────────────────────
//   A missing, misspelled or empty root is a MESSAGE, never a crash and never a
//   silent empty card: the request 404s, the next root is tried, and when none
//   is left the card names every folder it searched. A malformed
//   `mediaRoots.json` is the same story — it is read defensively below, and a
//   file that will not parse leaves the list empty rather than taking the app
//   down with it.
//
//   `npm run build` output served without Vite (GitHub Pages) has no such
//   mounts, so media there degrades to that same message. Raised with Rusty in
//   the AA050 report; not decided here.
//
// ── EDITING `mediaRoots.json` ────────────────────────────────────────────────
//   It is a plain JSON array of folders. Order matters — put the folder holding
//   most of the media first, so the common case resolves on the first attempt.
//   Forward slashes work on Windows and are what is shipped; if you paste a
//   path with backslashes you must double each one, because JSON reads `\` as
//   an escape. A trailing slash is fine. A blank entry is ignored, and a
//   repeated folder collapses so it does not cost a repeated request.

// `?raw` rather than a JSON import on purpose: it needs no compiler option,
// and it lets a file that will not parse degrade to an empty list below instead
// of failing the build. A person edits this JSON by hand.
import mediaRootsJson from './mediaRoots.json?raw';

/**
 * The URL prefix Vite serves the configured folders at. MUST match the constant
 * of the same value in `vite.config.ts`. Entry `i` of `mediaRoots.json` is
 * served at `${MEDIA_MOUNT}/${i}/`.
 */
export const MEDIA_MOUNT = '/__media';

/** One configured folder, as the app uses it. */
export interface MediaRoot {
  /** The folder exactly as written in `mediaRoots.json`. Shown to a person when
   *  a file will not load — it is the thing they would have to fix. It is never
   *  requested: the browser cannot read a disk path. */
  path: string;
  /** The same-origin prefix this folder is served at, e.g. `/__media/0`. This
   *  is what a media URL is built from. */
  base: string;
}

/**
 * Read `mediaRoots.json` defensively.
 *
 * A person edits that file by hand, so every way of getting it wrong has to
 * land somewhere survivable: not JSON, not an array, an entry that is not a
 * string, a blank entry, the same folder twice. None of those may throw — an
 * empty list is a valid state that the media card reports in words.
 *
 * The index each surviving root is mounted at is its position in the ORIGINAL
 * array, not its position after the skipping, because `vite.config.ts` indexes
 * the raw file. Dropping an entry must never shift the mount of the next one.
 */
function parseMediaRoots(text: string): MediaRoot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const roots: MediaRoot[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry: unknown, index: number) => {
    if (typeof entry !== 'string') return;
    const path = entry.trim();
    if (path === '') return;
    // Same folder written two ways is still the same folder: separators and
    // case are not what distinguishes one root from another on Windows.
    const key = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ path, base: `${MEDIA_MOUNT}/${index}` });
  });
  return roots;
}

/**
 * The configured media roots, in order, ready to use. An empty list means no
 * usable folder is configured; the card says so and names the file to edit.
 */
export const MEDIA_ROOTS: readonly MediaRoot[] = parseMediaRoots(mediaRootsJson);

/** The file a person edits, named in the UI so a message can point at it. */
export const MEDIA_ROOTS_FILE = 'src/lib/mediaRoots.json';

/** One thing to try for one media entry: the address the browser asks for, and
 *  the configured folder it stands for, so a failure can name the folder rather
 *  than only the address. */
export interface MediaCandidate {
  /** Same-origin, e.g. `/__media/0/resources/test_files/.../x.jpg`. */
  url: string;
  /** The folder from `mediaRoots.json` this address is served out of. */
  rootPath: string;
}

/**
 * Every candidate for a media entry, in the order the roots are configured.
 *
 * The relative path is passed through WHOLE and untouched — the server does the
 * overlapping against the configured folder, because only it can check what is
 * on disk. Here the join really is just `base + '/' + path`.
 *
 * An empty result is the "no media folder is configured" state — the list is
 * empty, unusable, or the entry has no path. It is never a throw and never a
 * guessed address. Duplicate addresses collapse so a repeated entry does not
 * cost a repeated request.
 *
 * EXPORTED for AA052, which is the offer Mike left in `media-roots-aa050.md`
 * and I have taken. The hover thumbnail has to ask for the SAME addresses in
 * the SAME order as this card, and a second copy of "how a root joins a path"
 * is precisely the thing that rots: the day the join changes, one caller
 * follows it and the other quietly does not. There is ONE joiner in this
 * codebase and both the panel and the tooltip call it.
 */
export function mediaCandidates(roots: readonly MediaRoot[], path: string): MediaCandidate[] {
  const rel = String(path ?? '').trim();
  if (rel === '') return [];
  const tail = rel.replace(/^[/\\]+/, '').split('/').map(encodeURIComponent).join('/');
  const out: MediaCandidate[] = [];
  for (const root of roots) {
    const base = String(root?.base ?? '').trim();
    if (base === '') continue;
    const url = `${base.replace(/\/+$/, '')}/${tail}`;
    if (!out.some(c => c.url === url)) out.push({ url, rootPath: String(root.path ?? '') });
  }
  return out;
}
