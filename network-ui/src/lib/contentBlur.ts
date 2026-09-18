// network-ui/src/lib/contentBlur.ts
//
// WHAT A VIEWER IS SHOWN BEFORE THEY CHOOSE TO LOOK — the one answer.
//
// Rusty, on the hover thumbnail (AA052): "I do want an image hover. And of
// course it will have the blur for it as well."
//
// ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
//   Two surfaces now conceal the same record: the media card in the selection
//   panel (`components/explorer/NodeMedia.tsx`) and the image thumbnail in the
//   graph's hover tooltip (`components/explorer/DirectedGraph.tsx`, filled by
//   `DataExplorer`). They are different components in different subtrees, and
//   two copies of a rule about what a viewer is shown before they choose to
//   look is not a tidiness problem — it is the exact shape of the bug where the
//   panel conceals a record and the tooltip quietly does not.
//
//   So the rule is here, once, and both callers ask it. It lived in
//   `NodeMedia.tsx` until AA052; a component file may not export a plain
//   function (`react-refresh/only-export-components`), and in any case the rule
//   is not the card's, it is the product's.
//
// ── NOT A SECURITY CONTROL ──────────────────────────────────────────────────
//   A concealed image is still fetched by the browser, in the panel and in the
//   tooltip alike. The blur decides what a viewer SEES before they choose to
//   look, not what the network carries. Access control is not this module's job
//   and it must not be mistaken for it.

import type { DaggerHandling } from '../types';

/**
 * AA048 — which of the two override buttons is pressed, if either.
 *
 * `null` is not a third button: it is the ordinary state in which the reveal
 * threshold decides. One value rather than a boolean per button, so "Hide All
 * and Reveal All are both on" is not a state that can be represented at all.
 */
export type ContentOverride = 'hide' | 'reveal';

/**
 * Has the PIPELINE marked this record for concealment? Read, never recomputed:
 * `content_blur` is false at exactly sensitivity 0.0 and true everywhere else,
 * and re-deriving it here would drift from the pipeline the first time that
 * rule changes (Mike's ingestion contract).
 *
 * An ABSENT `content_blur` is not an all-clear — it is optional in the type, so
 * a record can be scored without being answered, and only an explicit `false`
 * is the pipeline saying "do not conceal this". A record with NO handling block
 * at all answers `false` here: there is no sensitivity for the threshold to
 * compare against, so concealing it would create a state the slider could never
 * open. That is a missing-value policy, not a re-derivation from `sensitivity`.
 */
function blurredByPipeline(handling: DaggerHandling | null): boolean {
  return handling !== null && handling.content_blur !== false;
}

/**
 * Is this record above the viewer's reveal threshold? The slider is a REVEAL
 * threshold: sensitivity at or below it is shown, above it stays concealed. The
 * epsilon guards the last bit of a double — a slider step and a JSON literal
 * that both read "0.35" must compare as equal, not as greater.
 */
function aboveRevealThreshold(handling: DaggerHandling | null, revealThreshold: number): boolean {
  return handling !== null && handling.sensitivity > revealThreshold + 1e-9;
}

/**
 * THE conceal decision. Three states, resolved in priority order.
 *
 * An override answers for EVERY record, so neither `content_blur` nor the
 * threshold nor the per-node reveal is consulted when one is in force: a "Hide
 * All Content" that left some records showing because the pipeline had scored
 * them safe would be a button that does not do what it says.
 *
 * `revealed` is the CALLER's, because the per-node reveal is per node. The
 * media card owns that state for the record it has open; the tooltip asks with
 * `false` for every node that is not the open one, which is what makes
 * "revealed in the panel" mean this node and not the next one.
 */
export function isRecordConcealed(
  handling: DaggerHandling | null,
  revealThreshold: number,
  contentOverride: ContentOverride | null,
  revealed: boolean,
): boolean {
  if (contentOverride === 'hide') return true;
  if (contentOverride === 'reveal') return false;
  return blurredByPipeline(handling) && aboveRevealThreshold(handling, revealThreshold) && !revealed;
}

/**
 * Has the pipeline marked this record for blurring? Exposed for the media
 * card's STATUS LINE, which has to be able to say "the pipeline did not mark
 * this record for blurring" as a different sentence from "above the reveal
 * threshold". Both sentences name a sub-answer `isRecordConcealed` composes —
 * they are not a second statement of the rule.
 */
export function isBlurredByPipeline(handling: DaggerHandling | null): boolean {
  return blurredByPipeline(handling);
}

/** The other half of that status line. See `isBlurredByPipeline`. */
export function isAboveRevealThreshold(handling: DaggerHandling | null, revealThreshold: number): boolean {
  return aboveRevealThreshold(handling, revealThreshold);
}
