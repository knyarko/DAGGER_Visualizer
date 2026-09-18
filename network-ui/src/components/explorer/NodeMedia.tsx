import { useEffect, useMemo, useState } from 'react';
import type { DaggerHandling, DaggerMedia } from '../../types';
import { MEDIA_ROOTS_FILE, mediaCandidates, type MediaRoot } from '../../lib/mediaConfig';
import {
  isAboveRevealThreshold,
  isBlurredByPipeline,
  isRecordConcealed,
  type ContentOverride,
} from '../../lib/contentBlur';

// ─────────────────────────── DAGGER media surface ───────────────────────────
//
// The media a DAGGER triplet carries, rendered for the selected node. Read the
// entries with `daggerNodeMedia(index.nodesById.get(id))` — NEVER from
// `dataset.rows`, which the generic loader flattens: flattening turns the media
// array into dotted strings and silently drops a second entry.
//
// `media[].path` is RELATIVE and stays relative. The media ROOTS come from
// `lib/mediaRoots.json` through `lib/mediaConfig.ts` — internal configuration,
// not a viewer setting — and this component joins root to path at render time.
// No media file is ever copied, moved, renamed or regenerated.
//
// ── WHAT A ROOT IS, SINCE AA050 ─────────────────────────────────────────────
//   A root is a FOLDER ON DISK, not a URL. Rusty: "please make it work without
//   use of urls." `mediaConfig.ts` turns each configured folder into the
//   same-origin prefix Vite serves it at (`/__media/0`, `/__media/1`, …), and
//   that prefix is all this component ever concatenates. The folder itself is
//   carried alongside it only so a failure can name the thing a person would
//   have to fix. Read the join rule in `mediaConfig.ts`; the overlap between a
//   root's tail and a path's head is resolved on the server, so nothing here
//   has to know the shape of either.
//
// ── WHY `roots` IS A LIST (AA043) ───────────────────────────────────────────
//   One graph file can carry paths from more than one collection — the
//   CrisisMMD images and the 911 call audio live under different roots. Each
//   root is tried IN ORDER and the first that actually LOADS wins. "Resolves"
//   means the browser fetched and decoded it, which is the only definition
//   available here: nothing probes a URL ahead of time, so the media element
//   itself is the probe and its `onError` is what advances to the next root.
//
// ── THE SEAM FOR THE BLUR (Ravi, VT003) ─────────────────────────────────────
//   `MediaItem` renders the media element and NOTHING else. It always returns
//   exactly one wrapper element, in every state (player, unset base, load
//   failure, unrenderable channel), so a blur wrapper always has something to
//   wrap. Wrap the `<MediaItem …/>` call site inside `NodeMedia` below; you do
//   not need to touch the renderer itself.
//
// ── THE HANDLING TIER (Ravi, VT003) — now filled ─────────────────────────────
//   `NodeMedia` conceals the media element at the seam Dana left, and shows the
//   record's `filter_reason` and `warning_tags` around it. Three rules govern
//   this and none of them is re-derived here:
//
//   1. `content_blur` is the PIPELINE's answer — false at exactly sensitivity
//      0.0 and true everywhere else. It is read, never recomputed.
//   2. The viewer's slider is a REVEAL THRESHOLD: sensitivity at or below it is
//      shown, above it stays concealed. It arrives as `revealThreshold`.
//   3. Reveal is PER NODE. The state lives here and the call site keys this
//      component by the selected node id, so it cannot leak to the next node.
//
// ── THE THREE STATES (AA048) ────────────────────────────────────────────────
//   Rusty: "Add a Hide All Content button and a Reveal all Content Button. These
//   will override the slider. But the slider with auto unselect them upon
//   movement." So EXACTLY ONE of three things decides what a viewer sees, and
//   `contentOverride` is which:
//
//     'hide'   — every record is concealed, whatever its sensitivity says, and
//                whatever this node's per-node reveal used to say
//     'reveal' — every record is shown, whatever its sensitivity says
//     null     — the reveal threshold decides, exactly as it did before
//
//   The override is resolved BEFORE the threshold, in one expression, rather
//   than by layering conditions on top of the old one: two booleans that can
//   disagree about the same record is how you get a button that is on in the
//   sidebar and not in force on screen. The sidebar owns the state and clears it
//   when the slider moves; this component only reads it.
//
// ── THE DESCRIPTION IS ALWAYS VISIBLE (AA044) ───────────────────────────────
//   Rusty: "the descriptions should always be there underneath the media." This
//   REVERSES the sprint-1 call, where the description was concealed with the
//   media. See the note over the description block for the argument on each
//   side and why his wins.
//
//   `warning_tags` arrive already normalised by `daggerWarningTags` (the
//   `["None"]` no-warning answer reduced to `[]`). Every tag renders the same
//   way, deliberately: styling per tag would hard-code a vocabulary that lives
//   on the pipeline side and grows without this file.
//
//   NOT a security control. A concealed image is still fetched by the browser —
//   the blur decides what a viewer SEES before they choose to look, not what the
//   network carries. Access control is not this component's job and it must not
//   be mistaken for it.
//
// ── WHERE TWO PIECES OF THIS FILE WENT (AA052) ──────────────────────────────
//   `mediaCandidates` (the root-to-path joiner) now lives in
//   `lib/mediaConfig.ts`, beside the roots it joins, and the conceal decision
//   (`isRecordConcealed`, and the `ContentOverride` type it obeys) now lives in
//   `lib/contentBlur.ts`. Both are imported back here and this component
//   behaves exactly as it did.
//
//   They moved because the hover thumbnail (AA052) needs BOTH, and a second
//   copy of either — a second way to build a media address, a second answer to
//   "is this record concealed" — is the shape of the bug where the panel hides
//   a record and the tooltip does not. A component file also may not export a
//   plain function (`react-refresh/only-export-components`), so sharing them
//   from here was not available even if it had been the right call.

/** Channels this component knows how to play. Anything else is left to its
 *  description — the channel vocabulary is the pipeline's, not the UI's, so an
 *  unseen value must degrade rather than break. */
function isPlayableChannel(channel: unknown): channel is 'image' | 'audio' | 'video' {
  return channel === 'image' || channel === 'audio' || channel === 'video';
}

export interface MediaItemProps {
  /** One entry from `daggerNodeMedia(node)`. */
  media: DaggerMedia;
  /** The configured media folders from `lib/mediaConfig.ts`, tried in order
   *  until one loads. An empty list = no folder configured. */
  roots: readonly MediaRoot[];
}

/**
 * The media element itself — an `<img>`, `<audio controls>` or `<video
 * controls>` for a known channel, and a stated reason when there is nothing to
 * play. This is the element the blur wraps; it deliberately carries no
 * description, model or confidence text, so blurring it hides the media and
 * only the media.
 */
export function MediaItem({ media, roots }: MediaItemProps) {
  const candidates = useMemo(() => mediaCandidates(roots, media.path), [roots, media.path]);
  // How many roots have already failed for this entry. A failed load advances
  // the cursor to the next root; when it runs past the end, every configured
  // root has been tried and the card falls back to the description. Counting
  // rather than flagging is what makes "tried in order until one resolves"
  // a single piece of state, and it cannot loop: it only ever moves forward.
  const [attempt, setAttempt] = useState(0);
  const url = attempt < candidates.length ? candidates[attempt].url : null;
  const nextRoot = () => setAttempt(a => a + 1);

  const frame = 'rounded bg-black/40 border border-gray-700 overflow-hidden';
  const notice = 'px-2 py-3 text-[10px] text-gray-400';

  if (candidates.length === 0) {
    return (
      <div className={frame}>
        <div className={notice}>
          No media folder is configured — add one to <span className="font-mono">{MEDIA_ROOTS_FILE}</span> to load this file.
          <div className="mt-1 text-gray-500 break-all font-mono">{media.path}</div>
        </div>
      </div>
    );
  }

  if (!isPlayableChannel(media.channel)) {
    return (
      <div className={frame}>
        <div className={notice}>
          Channel “{String(media.channel ?? '—')}” has no player here — description only.
        </div>
      </div>
    );
  }

  // Every configured root has been tried and none of them holds this file.
  // All of them are named, not just the last: a viewer looking at a missing
  // file needs to see which folders were searched to know which one to fix. The
  // FOLDER is what a person edits, so the folder is what leads each line; the
  // address underneath it is what was actually requested, which is what a
  // network tab will show.
  if (url === null) {
    return (
      <div className={frame}>
        <div className={notice}>
          File did not load from {candidates.length === 1 ? 'the configured media folder' : `any of the ${candidates.length} configured media folders`} — showing the description below instead.
          Check <span className="font-mono">{MEDIA_ROOTS_FILE}</span>.
          {candidates.map(c => (
            <div key={c.url} className="mt-1 break-all font-mono">
              <div className="text-gray-500">{c.rootPath}</div>
              <div className="text-gray-600">{c.url}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // `key={url}` remounts the element when the cursor moves to the next root.
  // Swapping `src` alone does not reliably re-arm `onError` on <audio>/<video>,
  // and a stale element would end the walk at the first root.
  return (
    <div className={frame}>
      {media.channel === 'image' && (
        <img
          key={url}
          src={url}
          alt={media.description ?? media.filename ?? media.path}
          onError={nextRoot}
          className="block w-full max-h-56 object-contain"
        />
      )}
      {media.channel === 'audio' && (
        <audio
          key={url}
          src={url}
          controls
          preload="metadata"
          onError={nextRoot}
          className="block w-full"
        />
      )}
      {media.channel === 'video' && (
        <video
          key={url}
          src={url}
          controls
          preload="metadata"
          onError={nextRoot}
          className="block w-full max-h-56"
        />
      )}
    </div>
  );
}

export interface NodeMediaProps {
  /** Every entry the node carries. A record can hold several — they all render. */
  media: DaggerMedia[];
  /** The configured media folders from `lib/mediaConfig.ts`, tried in order
   *  until one loads. An empty list = no folder configured. This is internal
   *  configuration, not a viewer setting — there is no control for it. */
  roots: readonly MediaRoot[];
  /** The node's HANDLING block exactly as `daggerNodeHandling` returns it —
   *  the pipeline's object, untouched. null for a node that carries none: a
   *  cluster, a category, or a triplet the pipeline did not score. */
  handling?: DaggerHandling | null;
  /** The viewer's reveal threshold, 0.0–1.0. Sensitivity at or below it is
   *  shown; above it stays concealed. Defaults to 0.0 — what a viewer who has
   *  not touched the slider gets, and the only value that is certainly safe. */
  revealThreshold?: number;
  /** The node's warning tags as `daggerWarningTags` normalises them: `["None"]`
   *  already reduced to `[]`, every other tag verbatim. Nothing here validates
   *  the vocabulary — it is a living dictionary on the pipeline side. */
  warningTags?: string[];
  /** AA048. `'hide'` conceals this record regardless of its sensitivity,
   *  `'reveal'` shows it regardless of its sensitivity, and `null` — the
   *  default — hands the decision back to `revealThreshold`. Exactly one of the
   *  three is in force at any moment. */
  contentOverride?: ContentOverride | null;
  /** AA052. Called whenever the PER-NODE reveal below changes, so the hover
   *  thumbnail can obey it: "a node the viewer has revealed in the panel shows
   *  unblurred on hover; one they have not, does not."
   *
   *  The state stays HERE rather than being lifted, because the call site
   *  already keys this component by the selected node and the override in
   *  force — so a remount is what makes a reveal per-node, and a remount fires
   *  this with `false` on the way in. Lifting the state would have meant
   *  re-implementing that reset somewhere else and keeping the two in step.
   *  Optional: a caller that does not care about the reveal passes nothing. */
  onRevealedChange?: (revealed: boolean) => void;
}

/**
 * What a viewer reads BEFORE deciding whether to look. `filter_reason` is the
 * pipeline's own sentence about this record; when it is absent we say so rather
 * than inventing a reassuring one.
 */
function blurReason(handling: DaggerHandling | null): string {
  const reason = typeof handling?.filter_reason === 'string' ? handling.filter_reason.trim() : '';
  return reason !== '' ? reason : 'no filter reason recorded for this record';
}

/**
 * All of a node's media, one card per entry, under the record's handling
 * summary. Each card is the media element (`MediaItem`) plus the model's
 * reading of it: `description` is what a model saw, not a caption a person
 * wrote, so it is labelled as such and shown with the `model` that produced it
 * and its `conf`.
 *
 * When the record is concealed the MEDIA ELEMENT is covered and nothing else:
 * the description, the model and the confidence stay readable underneath it
 * (AA044). See the note over the description block for why that reverses the
 * sprint-1 call.
 */
export default function NodeMedia({
  media,
  roots,
  handling = null,
  revealThreshold = 0,
  warningTags = [],
  contentOverride = null,
  onRevealedChange,
}: NodeMediaProps) {
  // Per-node reveal, and ONLY this node. The call site keys this component by
  // the selected node id AND by the override in force, so both selecting a
  // different node and changing the override remount this component and drop
  // the reveal back to false. A reveal cannot leak from one record to the next,
  // and — AA048 — it cannot survive a trip through Hide All either.
  const [revealed, setRevealed] = useState(false);

  // AA052 — tell the call site, so the hover thumbnail can obey the same
  // reveal. This fires on mount too, with `false`, which is what makes the
  // remount that already resets the reveal also reset what the tooltip
  // believes: selecting another node, or crossing into or out of an override,
  // re-keys this component and the report goes back to "not revealed" with it.
  // Above the early return below, because a hook may not be conditional.
  useEffect(() => {
    onRevealedChange?.(revealed);
  }, [revealed, onRevealedChange]);

  // A node with neither media nor handling has nothing to say — cluster and
  // category nodes land here and stay silent, exactly as before.
  if (media.length === 0 && handling === null) return null;

  const sensitivity = handling ? handling.sensitivity : null;

  // AA048's three states and AA052's tooltip now read the SAME function, above.
  // These two are the sub-answers the status line below has to be able to name
  // — "the pipeline did not mark this" is a different sentence from "above the
  // threshold" — and they are the same predicates `isRecordConcealed` composes,
  // not a second statement of them.
  const blurred = isBlurredByPipeline(handling);
  const aboveThreshold = isAboveRevealThreshold(handling, revealThreshold);
  const concealed = isRecordConcealed(handling, revealThreshold, contentOverride, revealed);

  // Whether the per-node reveal is even a question here. Under either override
  // it is not: the buttons and the state line below go quiet rather than
  // offering a control that the state in force would ignore.
  const thresholdInForce = contentOverride === null;
  const reason = blurReason(handling);

  return (
    <div className="space-y-2">
      {handling && (
        <div className="rounded bg-gray-800/40 border border-gray-700 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-gray-400">Handling</span>
            <span className="text-[10px] text-gray-500">
              sensitivity {sensitivity !== null ? sensitivity.toFixed(2) : '—'}
            </span>
          </div>
          {/* Which of the three states is driving THIS record. An override says
              so in its own words and names itself, so a viewer never has to
              reconcile "Hide All is lit in the sidebar" with a sentence about a
              threshold that is not currently deciding anything. */}
          <div className={`text-[10px] mt-0.5 ${thresholdInForce ? 'text-gray-500' : 'text-amber-300'}`}>
            {contentOverride === 'hide'
              ? 'Hide All Content is in force — concealed regardless of sensitivity'
              : contentOverride === 'reveal'
                ? 'Reveal All Content is in force — shown regardless of sensitivity'
                : !blurred
                  ? 'the pipeline did not mark this record for blurring'
                  : concealed
                    ? `above the reveal threshold (${revealThreshold.toFixed(2)}) — concealed`
                    : !aboveThreshold
                      ? `at or below the reveal threshold (${revealThreshold.toFixed(2)}) — shown`
                      : 'revealed on this node only'}
            {thresholdInForce && revealed && blurred && aboveThreshold && (
              <button
                onClick={() => setRevealed(false)}
                className="ml-2 text-blue-400 hover:text-blue-300"
              >
                conceal again
              </button>
            )}
          </div>
          {/* Warning tags. Every tag is drawn the same way on purpose: colouring
              or ordering by meaning would hard-code a vocabulary that grows on
              the pipeline side, and a tag this UI has never seen must render. */}
          {warningTags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {warningTags.map(tag => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 rounded text-[10px] bg-amber-950/60 border border-amber-800/70 text-amber-200"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* A record carrying media but NO handling block at all. `handling` is
          optional in the pipeline's shape, so this is a record it did not score,
          and saying so is not the same statement as scoring it 0.00. It is left
          visible rather than concealed: with no `sensitivity` there is nothing
          for the reveal threshold to compare against, so concealing it would
          create a state the slider could never open. Flagged to the Scrum Master
          as a question rather than decided quietly. */}
      {handling === null && media.length > 0 && (
        <div className="text-[10px] text-gray-500">
          no handling block on this record — the pipeline did not score it
        </div>
      )}

      {media.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-2">
            Media ({media.length})
          </div>
          <div className="space-y-2">
            {media.map((m, i) => (
              <div
                key={`${i}:${m.path}`}
                className="rounded bg-gray-800/40 border border-gray-700 overflow-hidden"
              >
                <div className="px-2 py-1.5 border-b border-gray-700 flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider text-emerald-400">
                    {String(m.channel ?? '—')}
                  </span>
                  <span className="text-[10px] text-gray-400 truncate" title={m.path}>
                    {m.filename ?? m.path}
                  </span>
                </div>

                <div className="p-2">
                  {/* ── Ravi's seam (VT003) ──────────────────────────────────────
                      Dana's element, now wrapped. `MediaItem` always renders one
                      wrapper, so the blur covers something in every state — player,
                      unset base, load failure and unrenderable channel alike — and
                      never wraps null.

                      `filter_reason` is the `title` on the covering surface AND is
                      printed on it, so it is readable BEFORE the reveal. A viewer
                      reads it to decide whether to look; behind the reveal it would
                      be answering a question they have already been made to answer.

                      `pointer-events-none` on the blurred subtree means a concealed
                      <audio>/<video> cannot be played through the blur, and
                      `aria-hidden` keeps it out of the accessibility tree — the
                      reason and the button are what a screen reader gets. */}
                  {concealed ? (
                    <div className="relative rounded overflow-hidden" title={reason}>
                      <div className="blur-lg pointer-events-none select-none" aria-hidden="true">
                        <MediaItem media={m} roots={roots} />
                      </div>
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2 text-center bg-gray-950/55">
                        <div className="text-[10px] leading-snug text-amber-200">{reason}</div>
                        {/* AA048 — under Hide All the per-node reveal is not
                            offered at all. A button that the state in force
                            would ignore is worse than no button: it reads as
                            "Hide All can be clicked through", which is exactly
                            what Rusty said must not happen. The way out is
                            named, so the control is not simply missing. */}
                        {thresholdInForce ? (
                          <button
                            onClick={() => setRevealed(true)}
                            className="px-2 py-0.5 rounded text-[10px] bg-gray-700 hover:bg-gray-600 text-white"
                          >
                            Reveal this node
                          </button>
                        ) : (
                          <div className="text-[10px] text-gray-400">
                            Hide All Content is in force — clear it in the sidebar to reveal one node
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <MediaItem media={m} roots={roots} />
                  )}
                </div>

                {/* ── AA044: the description is ALWAYS visible ─────────────────
                    Rusty: "the descriptions should always be there underneath
                    the media."

                    This is a DELIBERATE REVERSAL of the sprint-1 call, and it is
                    worth writing down so nobody re-argues it from first
                    principles. Sprint 1 concealed the description along with the
                    media, reasoning that "severe visible trauma to a body"
                    printed as text under a blurred image conceals nothing.

                    Rusty's call wins, and it is the right one for what this
                    viewer is FOR: the description is how an analyst decides
                    whether a record is worth opening at all. Concealing it makes
                    the blur a wall rather than a warning — the viewer has to
                    reveal the image to learn whether they wanted to see the
                    image. A sentence a model wrote is also a categorically
                    milder thing than the frame it describes, and it is the same
                    class of text as `filter_reason`, which has always been
                    readable on the covering surface for exactly this reason.

                    So: description, model and confidence are all outside the
                    seam and stay readable whether the media is concealed or not.
                    The blur covers the MEDIA. That is its whole job. */}
                <div className="px-2 pb-2">
                  <div className="text-[9px] uppercase tracking-wider text-gray-500">
                    Model reading of this media
                  </div>
                  <div className="text-xs text-gray-300 mt-0.5">
                    {m.description && String(m.description).trim()
                      ? String(m.description)
                      : <span className="text-gray-500">no description on this entry</span>}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-1 flex flex-wrap gap-x-3">
                    <span>model: {m.model ? String(m.model) : '—'}</span>
                    <span>conf: {m.conf === undefined || m.conf === null || m.conf === '' ? '—' : String(m.conf)}</span>
                    {m.media_type && <span>{String(m.media_type)}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
