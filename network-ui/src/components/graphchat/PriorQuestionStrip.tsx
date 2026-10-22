/**
 * The prior-question strip — the file picker's sample-card idiom, deliberately.
 *
 * Same shape as the upload screen's sample cards: a full-width left-aligned
 * button, a title over a muted description. What changes is the content, not
 * the idiom, so a viewer who has used the picker already knows what these are.
 *
 * On a narrow viewport it becomes a horizontally scrolling row of the same
 * cards, NEVER a dropdown — a dropdown hides the thing that teaches a
 * first-timer what to ask.
 *
 * ── THE EMPTY STATE SAYS WHY THE LIST IS SHARED ─────────────────────────────
 *   "so you, or anyone else on this graph, can reopen them" — the "anyone else"
 *   is load-bearing and is said on screen, because that is the whole reason
 *   this list lives on a service rather than in this browser.
 *
 * ── AND IT SAYS WHEN IT IS NOT THERE ────────────────────────────────────────
 *   When the service is unreachable the strip is EMPTY for a reason, and an
 *   empty strip that says nothing reads as "nobody has asked anything", which
 *   is a different and wrong claim. So the reason is printed.
 */

import type { HistoryEntry } from './serviceClient';

export interface PriorQuestionStripProps {
  entries: HistoryEntry[];
  openAnswerId: string | null;
  busy: boolean;
  onOpen: (entry: HistoryEntry) => void;
  serviceReason: string | null;
}

export default function PriorQuestionStrip({
  entries,
  openAnswerId,
  busy,
  onOpen,
  serviceReason,
}: PriorQuestionStripProps) {
  return (
    <div>
      <div className="gc-strip-label">Already answered</div>
      {serviceReason !== null ? (
        <div className="gc-empty">
          <b>The shared list of answered questions is not available.</b>
          {serviceReason}. The list is kept on the query service rather than in this browser, because
          a list in one person&rsquo;s browser is not shared with anyone. Asking still works.
        </div>
      ) : entries.length === 0 ? (
        <div className="gc-empty">
          <b>Nothing answered yet.</b>
          Questions you ask land here so you, or anyone else on this graph, can reopen them.
        </div>
      ) : (
        <div className="gc-strip">
          {entries.slice(0, 8).map(entry => (
            <button
              key={entry.answerId}
              type="button"
              className="gc-sample"
              aria-current={entry.answerId === openAnswerId ? 'true' : undefined}
              disabled={busy}
              onClick={() => onOpen(entry)}
            >
              <div className="gc-sample-title">{entry.question}</div>
              <div className="gc-sample-desc">
                {entry.kind}
                {entry.ok ? '' : ' · the model did not answer'}
                {entry.hitCount > 0 ? ` · reused ${entry.hitCount}×` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
