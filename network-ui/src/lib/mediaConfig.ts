// network-ui/src/lib/mediaConfig.ts
//
// WHERE THE MEDIA LIVES. This is the one file to edit.
//
// A DAGGER record's `media[].path` is RELATIVE and stays relative — nothing is
// ever copied, moved, renamed or regenerated. The only thing that changes
// between machines is the ROOT those relative paths hang off, and that root is
// internal configuration, not something a viewer types in: a person looking at
// the graph has no way to know where the files were served from.
//
// ── WHY AN ARRAY ────────────────────────────────────────────────────────
//   One graph file can carry paths from more than one collection. The
//   CrisisMMD images and the 911 call audio sit under different sections of
//   the DAGGER tree, so a single root cannot reach both. Each entry below is
//   tried IN ORDER and the first one the browser actually loads wins; a root
//   that does not hold a given file simply fails and the next is tried. A
//   database will replace this later — until then, a list of roots will do.
//
// ── TO CHANGE A ROOT ────────────────────────────────────────────────────
//   Edit the strings below. Order matters: put the root that holds most of
//   the media first, so the common case resolves on the first attempt.
//   A trailing slash is optional — `http://host:8000` and `http://host:8000/`
//   behave identically. Blank entries are ignored.
//
//   Serving the CrisisMMD root, for reference:
//       cd C:\...\DAGGER\crisis_triplets
//       python -m http.server 8000
//   which makes `resources/test_files/datasets/Crisis_MMD_v2.0_08_07_2026/
//   images/foo.jpg` reachable at `http://localhost:8000/resources/...`.
//
// ── AN EMPTY LIST IS A VALID STATE ──────────────────────────────────────
//   With no usable root, the media card says the media root is not configured
//   and prints the relative path it would have used. Nothing throws and no URL
//   is ever guessed.

/**
 * The media roots, tried in order until a path resolves.
 *
 * NOTE for Rusty: the first entry is the CrisisMMD root named in the sprint
 * brief. The second is the 911 audio section, which is served separately; the
 * port below is a placeholder because the brief did not state it. Correct it
 * here and nothing else changes — a root that does not answer costs one failed
 * request and falls through to the next.
 */
export const MEDIA_BASE_URLS: string[] = [
  'http://localhost:8000',   // DAGGER/crisis_triplets — CrisisMMD images
  'http://localhost:8001',   // the 911 section — call audio
];
