/**
 * The ask bar. Full width, under the top bar.
 *
 * The placeholder carries a REAL example rather than the word "Search" — a
 * first-timer looking at a graph of extracted facts does not know what this
 * will answer, and the placeholder is the cheapest place to tell them.
 *
 * The hint line is not a tooltip: it stays visible at rest and on focus.
 *
 * Enter asks, Shift+Enter is a new line. Ask is disabled until there is a
 * non-whitespace character. The typed text is NEVER cleared by a failure.
 */

import type { ModelProviderId, ProviderAvailability } from './serviceClient';

export interface AskBarProps {
  value: string;
  onChange: (value: string) => void;
  onAsk: () => void;
  busy: boolean;
  providers: ProviderAvailability[];
  provider: ModelProviderId;
  onProviderChange: (provider: ModelProviderId) => void;
  /** Set when the service is unreachable: the model select has nothing real to
   *  offer and says so instead of listing four options that cannot be used. */
  serviceReason: string | null;
}

export default function AskBar({
  value,
  onChange,
  onAsk,
  busy,
  providers,
  provider,
  onProviderChange,
  serviceReason,
}: AskBarProps) {
  const canAsk = value.trim() !== '' && !busy;

  return (
    <div className="gc-askbar">
      <div className="gc-askrow">
        <textarea
          className="gc-askfield"
          value={value}
          rows={2}
          placeholder={'Ask anything about this graph \u2014 for example, how many civilian deaths it reports.'}
          aria-label="Ask a question about this graph"
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (canAsk) onAsk();
            }
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gc-sp-2)' }}>
          <button type="button" className="gc-btn" onClick={onAsk} disabled={!canAsk}>
            {busy ? 'Asking…' : 'Ask'}
          </button>
          {serviceReason === null ? (
            <select
              className="gc-select"
              value={provider}
              aria-label="Model"
              onChange={event => onProviderChange(event.target.value as ModelProviderId)}
            >
              {(Array.isArray(providers) ? providers : []).map(entry => (
                <option key={entry.id} value={entry.id} disabled={!entry.usable}>
                  {entry.label}
                  {entry.usable ? '' : ' — ' + (entry.reason ?? 'not usable')}
                </option>
              ))}
            </select>
          ) : (
            <span className="gc-askhint" style={{ maxWidth: 220 }}>
              No model configured &mdash; answers will be the counts and the rows, without a written
              sentence.
            </span>
          )}
        </div>
      </div>
      <div className="gc-askhint">Enter to ask &middot; Shift+Enter for a new line</div>
    </div>
  );
}
