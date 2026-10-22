/**
 * "25 of 412" — the display cap said out loud.
 *
 * The cap is a DISPLAY cap and never a retrieval cap. The engine resolved the
 * whole set, holds the whole set, and handed this view the first page plus the
 * true total; nothing later — a count, a chart, an export — is ever computed
 * from the page.
 *
 * Both numbers are at the same weight and the same size. The true total is
 * never smaller or quieter than the shown count: a cap that looks like a
 * truncation is a cap people distrust, so the sentence that says the whole set
 * is retained is on screen rather than in a tooltip.
 */

export interface ResultSetHeaderProps {
  shownCount: number;
  total: number;
  onShowMore?: () => void;
  busy?: boolean;
}

export default function ResultSetHeader({ shownCount, total, onShowMore, busy }: ResultSetHeaderProps) {
  const complete = shownCount >= total;
  return (
    <div>
      <div className="gc-resulthead">
        {complete ? (
          <>
            <b>{total}</b> of <b>{total}</b> shown
          </>
        ) : (
          <>
            <b>{shownCount}</b> of <b>{total}</b> shown
          </>
        )}
      </div>
      <div className="gc-resultnote">
        the whole {total} is held in memory &mdash; every count, chart and export is computed from all
        of it, never from these {shownCount}.
      </div>
      {!complete && onShowMore && (
        <button type="button" className="gc-btn-quiet gc-btn" style={{ marginTop: 'var(--gc-sp-2)' }} onClick={onShowMore} disabled={busy}>
          {busy ? 'loading…' : 'Show the next 25'}
        </button>
      )}
    </div>
  );
}
