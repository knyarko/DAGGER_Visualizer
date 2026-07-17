// network-ui/src/lib/lockConfig.ts
//
// Per-file locks for sample datasets.
//
// A sample is LOCKED if — and only if — it has an entry in the map below.
// No shared/admin password: each locked file has its own.
//
// ── THE KEY ─────────────────────────────────────────────────────────────
//   The key is the sample's path RELATIVE to BASE_URL — the `samples/...`
//   part of the url in FileUpload.tsx, WITHOUT the leading base.
//   Why relative? BASE_URL differs by environment:
//       dev (npm run dev):  '/'                    → url = /samples/Foo.json
//       GitHub Pages:       '/DAGGER_Visualizer/'  → url = /DAGGER_Visualizer/samples/Foo.json
//   Keying on the relative path makes the lock work identically in both.
//
// ── TOGGLE A LOCK ───────────────────────────────────────────────────────
//   Lock a file:    add a line →   'samples/Foo.json': 'thepassword',
//   Unlock a file:  delete that line.
//
// Matching is EXACT: case-sensitive and whitespace-sensitive. All letters,
// all numbers, or a mix all work — it's a plain string comparison.
//
// ── LIGHT GATE, NOT SECURITY ────────────────────────────────────────────
//   The check runs in the browser. Passwords are readable in the shipped JS
//   bundle, and the sample files stay fetchable by direct URL. This keeps
//   casual users out; it keeps no secrets.

export const SAMPLE_PASSWORDS: Record<string, string> = {
  'samples/Causal_Relationship_Graph_Viz.json': 'depa',
  // 'samples/Timeline_Demo_Viz.json': 'anotherpassword',  // ← example: lock the other sample
};
