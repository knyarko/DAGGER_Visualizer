/**
 * The wide view reached from a loaded graph.
 *
 * ── THE ENTRY POINT'S PROMISE ───────────────────────────────────────────────
 *   This view is reached from a graph that is ALREADY LOADED and it carries
 *   that graph's state across: the parsed nodes and edges, the media roots, the
 *   reveal threshold and the Hide-All / Reveal-All override. The maintainer
 *   never picks the same file twice, and a conceal setting that did not survive
 *   the mode switch would be a conceal setting that is off.
 *
 * ── WHEN THE INDEX IS BUILT ─────────────────────────────────────────────────
 *   On arrival here, not at file load. The engine seat measured roughly 1.7 s
 *   and 70 MB for the index at the production corpus size; adding that to the
 *   Visualizer's own load would charge every viewer for a feature they may not
 *   open. `loadGraph` reports real timings and they are shown, because a
 *   measured number is better company during a stall than a spinner that claims
 *   nothing. A Web Worker is the next step if this is still too slow; it is not
 *   built here.
 *
 * ── WHAT HAPPENS WHEN THE SERVICE IS NOT THERE ──────────────────────────────
 *   The feature degrades and says so. The engine runs in this browser, so
 *   retrieval and aggregation still work and every count, figure, chart and row
 *   is real. What is lost is the model's sentence, the shared prior-question
 *   strip and the near-duplicate cache, all three of which live on the service
 *   because a cache in one person's browser is not shared with anyone. The
 *   banner below says exactly that, in words, rather than leaving a viewer to
 *   infer it from an empty strip.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './tokens.css';
import AskBar from './AskBar';
import DossierCard from './DossierCard';
import PriorQuestionStrip from './PriorQuestionStrip';
import ThemeControl from './ThemeControl';
import { applyTheme, currentTheme, type GraphChatTheme } from './theme';
import {
  buildEngine,
  classifyQuestion,
  rawGraphFromDaggerIndex,
  runAggregate,
  runRetrieval,
  type LoadedEngine,
} from './engineBridge';
import { resolveGrouping } from '../../../../graph-chat/server/grouping.ts';
import * as service from './serviceClient';
import type { GraphChatAnswer } from './answerModel';
import type { ContentOverride } from '../../lib/contentBlur';
import type { MediaRoot } from '../../lib/mediaConfig';
import type { DaggerIndex } from '../../types';
import type { AskRequest, ModelProviderId, ProviderAvailability } from './serviceClient';

export interface GraphChatViewProps {
  /** The loaded graph, exactly as the Visualizer already holds it. */
  dagger: DaggerIndex;
  /** What the viewer loaded, for the top bar and for the service's history. */
  graphLabel: string;
  roots: readonly MediaRoot[];
  revealThreshold: number;
  contentOverride: ContentOverride | null;
  onBack: () => void;
}

export default function GraphChatView(props: GraphChatViewProps) {
  const [theme, setTheme] = useState<GraphChatTheme>(() => currentTheme());
  const [persisted, setPersisted] = useState(true);

  const [loaded, setLoaded] = useState<LoadedEngine | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<GraphChatAnswer[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);

  const [providers, setProviders] = useState<ProviderAvailability[]>([]);
  const [provider, setProvider] = useState<ModelProviderId>('ollama');
  const [historyEntries, setHistoryEntries] = useState<service.HistoryEntry[]>([]);
  const [serviceReason, setServiceReason] = useState<string | null>('checking the query service');

  const counter = useRef(0);

  const changeTheme = useCallback((next: GraphChatTheme) => {
    setTheme(next);
    setPersisted(applyTheme(next));
  }, []);

  /* The index is built here, on arrival, and never during the graph's own load.
   * It is deferred one frame so the "building" line paints before the main
   * thread is taken. */
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      try {
        const result = buildEngine(rawGraphFromDaggerIndex(props.dagger));
        if (!cancelled) setLoaded(result);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'the graph could not be read');
        }
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [props.dagger]);

  /* The service is OPTIONAL. Nothing below blocks on it and nothing here throws
   * into a render: every call returns a result or a reason. */
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void (async () => {
      const health = await service.health();
      if (cancelled) return;
      if (!health.ok) {
        setServiceReason(health.reason);
        setProviders([]);
        setHistoryEntries([]);
        return;
      }
      setServiceReason(null);
      const [available, history] = await Promise.all([
        service.providers(),
        service.history(loaded.graphKey),
      ]);
      if (cancelled) return;
      if (available.ok) {
        setProviders(available.value);
        const usable = available.value.find(entry => entry.usable);
        if (usable) setProvider(usable.id);
      }
      if (history.ok) setHistoryEntries(history.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  const ask = useCallback(async () => {
    const text = question.trim();
    if (text === '' || !loaded) return;
    setBusy(true);
    counter.current += 1;
    const id = 'a' + String(counter.current);
    const kind = classifyQuestion(text);

    const answer: GraphChatAnswer = {
      id,
      question: text,
      kind,
      askedAt: new Date().toISOString(),
      aggregate: null,
      retrieval: null,
      grouping: null,
      offset: 0,
      service: null,
      serviceReason: null,
      error: null,
      pinned: false,
      expanded: true,
    };

    try {
      if (kind === 'aggregate') {
        answer.aggregate = runAggregate(loaded.engine, text);
        /* B069. The grouping the answer is REPORTED with, resolved here, once,
         * with the service's own function rather than a second copy of it.
         *
         * The engine deliberately does not collapse when the file carries no
         * record id - it refuses to guess a key the data did not supply - so
         * its `messageGroups` are one group per triplet on the legacy corpus.
         * Drawing those is what made the chart show two triplets restating one
         * message as two independent bars while the line above it quoted the
         * collapsed count. Resolving it here means the chart, the evidence
         * table, the grouping strip and the service all describe one grouping.
         *
         * It runs with or without the service, because the static deploy has
         * no service at all and the no-compounding picture has to be right
         * there too. The service runs the same function on the same input, so
         * the two cannot disagree. */
        if (answer.aggregate.evidence.kind === 'aggregate') {
          answer.grouping = resolveGrouping(
            answer.aggregate.evidence.messageGroups,
            loaded.engine.corpus.messageKeyAvailable,
          );
        }
      } else {
        answer.retrieval = runRetrieval(loaded.engine, text);
      }
    } catch (error) {
      answer.error = error instanceof Error ? error.message : 'the engine could not answer that';
    }

    /* Newest first, and exactly one card expanded at a time unless a viewer has
     * pinned one open. Collapsing is a boolean on an object that keeps
     * everything, so nothing below is ever recomputed to put it back. */
    setAnswers(previous => [
      answer,
      ...previous.map(a => (a.pinned ? a : { ...a, expanded: false })),
    ]);
    setQuestion('');

    const envelope = answer.aggregate ?? answer.retrieval;
    if (envelope && answer.error === null) {
      const request: AskRequest = {
        graphKey: loaded.graphKey,
        graphLabel: props.graphLabel,
        question: text,
        kind,
        evidence: envelope.evidence,
        query: envelope.query,
        engine: envelope.engine,
        shape: envelope.shape,
        total: envelope.total,
        messageKeyAvailable: loaded.engine.corpus.messageKeyAvailable,
        provider,
        sample:
          answer.retrieval === null
            ? undefined
            : service.sampleFrom(
                answer.retrieval.items.slice(0, service.MAX_SAMPLE_ITEMS).map(hit => ({
                  triplet_id: hit.triplet.triplet_id,
                  label: hit.triplet.label,
                  msg_text: hit.triplet.msg_text,
                  mediaCount: hit.triplet.media.length,
                })),
              ),
      };
      const response = await service.ask(request);
      setAnswers(previous =>
        previous.map(a =>
          a.id === id
            ? response.ok
              ? { ...a, service: response.value, serviceReason: null }
              : { ...a, service: null, serviceReason: response.reason }
            : a,
        ),
      );
      if (response.ok) {
        const refreshed = await service.history(loaded.graphKey);
        if (refreshed.ok) setHistoryEntries(refreshed.value);
      }
    } else if (envelope) {
      setAnswers(previous => previous.map(a => (a.id === id ? { ...a } : a)));
    }

    setBusy(false);
  }, [question, loaded, provider, props.graphLabel]);

  const toggleExpanded = useCallback((id: string) => {
    setAnswers(previous =>
      previous.map(a => {
        if (a.id === id) return { ...a, expanded: !a.expanded };
        if (a.pinned) return a;
        return { ...a, expanded: false };
      }),
    );
  }, []);

  const togglePinned = useCallback((id: string) => {
    setAnswers(previous => previous.map(a => (a.id === id ? { ...a, pinned: !a.pinned } : a)));
  }, []);

  /* The cap is walked forward over the set already in memory. No round trip. */
  const showMore = useCallback((id: string) => {
    setAnswers(previous => previous.map(a => (a.id === id ? { ...a, offset: a.offset + 25 } : a)));
  }, []);

  const reopen = useCallback((entry: service.HistoryEntry) => {
    setQuestion(entry.question);
  }, []);

  const degraded = serviceReason !== null && serviceReason !== 'checking the query service';

  const timings = useMemo(() => {
    if (!loaded) return null;
    return `${loaded.tripletCount} triplets \u00b7 ingest ${Math.round(loaded.ingestMs)} ms \u00b7 index ${Math.round(loaded.indexMs)} ms`;
  }, [loaded]);

  return (
    <div className="gc-root">
      <div className="gc-topbar">
        <button type="button" className="gc-btn gc-btn-quiet" onClick={props.onBack}>
          &larr; Back to the graph
        </button>
        <h1 className="gc-topbar-title">Ask about this graph</h1>
        <span className="gc-topbar-file" title={props.graphLabel}>
          {props.graphLabel}
        </span>
        <span className="gc-spacer" />
        {timings && <span className="gc-topbar-file">{timings}</span>}
        <ThemeControl theme={theme} onChange={changeTheme} persisted={persisted} />
      </div>

      <div className="gc-scroll">
        <div className="gc-wide">
          {degraded && (
            <div className="gc-degraded">
              <b>The query service is not reachable</b> &mdash; {serviceReason}. This is a supported
              state, not a failure: the Visualizer ships as a static page with no server, and the
              query engine runs here in your browser.
              <ul>
                <li>
                  Still working: retrieval, the counting, the grouping into source messages, the
                  figures, the chart, the evidence and every row.
                </li>
                <li>
                  Not available: the written answer, the list of questions other people have already
                  asked on this graph, and the near-duplicate cache that would reuse one.
                </li>
              </ul>
            </div>
          )}

          {loadError !== null && <div className="gc-danger-block">{loadError}</div>}

          {loaded === null && loadError === null && (
            <div className="gc-empty">
              <b>Reading the graph.</b>
              Building the search index for this file. This happens once, when you open this view,
              rather than every time a graph is loaded.
            </div>
          )}

          {loaded !== null && (
            <>
              <AskBar
                value={question}
                onChange={setQuestion}
                onAsk={() => void ask()}
                busy={busy}
                providers={providers}
                provider={provider}
                onProviderChange={setProvider}
                serviceReason={degraded ? serviceReason : null}
              />

              <PriorQuestionStrip
                entries={historyEntries}
                openAnswerId={null}
                busy={busy}
                onOpen={reopen}
                serviceReason={degraded ? serviceReason : null}
              />

              <div className="gc-stack" style={{ marginTop: 'var(--gc-sp-5)' }}>
                {answers.length === 0 ? (
                  <div className="gc-empty">
                    <b>No answers yet.</b>
                    Ask something above, or pick one of the already-answered questions.
                  </div>
                ) : (
                  answers.map(answer => (
                    <DossierCard
                      key={answer.id}
                      answer={answer}
                      dagger={props.dagger}
                      roots={props.roots}
                      revealThreshold={props.revealThreshold}
                      contentOverride={props.contentOverride}
                      highlightTripletId={highlight}
                      onHighlight={setHighlight}
                      onToggleExpanded={toggleExpanded}
                      onTogglePinned={togglePinned}
                      onShowMore={showMore}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
