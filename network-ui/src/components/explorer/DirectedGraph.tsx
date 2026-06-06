import { useEffect, useMemo, useRef } from 'react';
import * as d3 from 'd3';
import type { FieldInfo } from '../../lib/parseData';
import type { VisualMapping } from '../../lib/mapping';
import { DEGREE_IN, DEGREE_OUT, DEGREE_TOTAL, isDegreeSentinel } from '../../lib/mapping';

interface Props {
  rows: Record<string, unknown>[];
  fields: FieldInfo[];
  mapping: VisualMapping;
  selectedNode: string | null;
  onNodeClick: (id: string | null) => void;
  /** When non-null, dim every node whose id is not in this set. */
  highlightedNodes?: Set<string> | null;
  /** When non-null, mark these "src|||tgt" edges as the active chain (cyan). */
  highlightedEdgeKeys?: Set<string> | null;
  /** Multiplier on link distance + charge strength. 1.0 = default packing. */
  spread?: number;
  /**
   * Edge label visibility mode.
   *   · 'auto' — show when total edge count ≤ density cap, hide otherwise
   *   · 'on'   — always show (respects density cap warnings but renders anyway)
   *   · 'off'  — never show
   */
  edgeLabelMode?: 'auto' | 'on' | 'off';
}

// Baseline force constants — multiplied by the `spread` prop at render time.
const BASE_LINK_DISTANCE = 70;
const BASE_CHARGE_STRENGTH = -200;

interface Node extends d3.SimulationNodeDatum {
  id: string;
  colorKey: string | null;
  sizeValue: number;
  inDegree: number;
  outDegree: number;
}

interface Link extends d3.SimulationLinkDatum<Node> {
  source: string | Node;
  target: string | Node;
  rawRow: Record<string, unknown>;
  label: string;
  weight: number;
  edgeKey: string;
}

const PALETTE = d3.schemeTableau10;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return String(v);
}

// Tooltips render with .html(), so we must defensively escape values — a
// number of datasets (e.g. the Causal_Links / Relationship_Graph ones) embed
// raw HTML in fields like `info` that would otherwise render unintentionally.
function escapeHTML(s: string): string {
  return s.replace(/[&<>]/g, c => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'
  ));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Field names treated as long-form explanatory text — pinned to the top of
// tooltips regardless of column position, and allowed more characters before
// truncation.
const JUSTIFICATION_PATTERNS = [
  'justification', 'rationale', 'reason', 'explanation',
  'description', 'summary', 'note', 'comment',
];

function isJustificationField(name: string): boolean {
  const lower = name.toLowerCase();
  return JUSTIFICATION_PATTERNS.some(p => lower.includes(p));
}

export default function DirectedGraph({
  rows,
  fields,
  mapping,
  selectedNode,
  onNodeClick,
  highlightedNodes = null,
  highlightedEdgeKeys = null,
  spread = 1.0,
  edgeLabelMode = 'auto',
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Stable handle to the running simulation so we can retune forces without
  // rebuilding the whole SVG when the spread slider moves.
  const simRef = useRef<d3.Simulation<Node, Link> | null>(null);
  const spreadRef = useRef(spread);
  spreadRef.current = spread;

  const fieldsByName = useMemo(() => new Map(fields.map(f => [f.name, f])), [fields]);

  const graph = useMemo(() => {
    const { sourceField, targetField, nodeColorField, nodeSizeField, edgeLabelField, edgeWeightField } = mapping;
    const nodeMap = new Map<string, Node>();
    const links: Link[] = [];

    const colorFieldInfo = nodeColorField ? fieldsByName.get(nodeColorField) : undefined;
    const sizeIsDegree = isDegreeSentinel(nodeSizeField);
    const sizeFieldInfo = !sizeIsDegree && nodeSizeField ? fieldsByName.get(nodeSizeField) : undefined;
    const weightFieldInfo = edgeWeightField ? fieldsByName.get(edgeWeightField) : undefined;

    for (const row of rows) {
      const src = row[sourceField];
      const tgt = row[targetField];
      if (src === null || src === undefined || src === '') continue;
      if (tgt === null || tgt === undefined || tgt === '') continue;
      const srcId = String(src);
      const tgtId = String(tgt);

      const ensure = (id: string, row: Record<string, unknown>) => {
        let n = nodeMap.get(id);
        if (!n) {
          n = {
            id,
            colorKey: colorFieldInfo ? (row[colorFieldInfo.name] != null ? String(row[colorFieldInfo.name]) : null) : null,
            sizeValue: 0,
            inDegree: 0,
            outDegree: 0,
          };
          nodeMap.set(id, n);
        }
        return n;
      };
      const srcNode = ensure(srcId, row);
      const tgtNode = ensure(tgtId, row);
      srcNode.outDegree += 1;
      tgtNode.inDegree += 1;

      // Track size value for source if numeric; sum across rows
      if (sizeFieldInfo && sizeFieldInfo.type === 'number') {
        const v = Number(row[sizeFieldInfo.name]);
        if (Number.isFinite(v)) srcNode.sizeValue += v;
      }

      const label = edgeLabelField ? fmt(row[edgeLabelField]) : '';
      let weight = 1;
      if (weightFieldInfo && weightFieldInfo.type === 'number') {
        const v = Number(row[weightFieldInfo.name]);
        if (Number.isFinite(v)) weight = v;
      }

      links.push({
        source: srcId,
        target: tgtId,
        rawRow: row,
        label,
        weight,
        edgeKey: `${srcId}|||${tgtId}`,
      });
    }

    // Resolve sizeValue based on mapping mode:
    //   · numeric field selected → already summed above
    //   · degree sentinel selected → use in/out/total degree
    //   · nothing selected → fall back to total degree (better than 0)
    if (!sizeFieldInfo || sizeFieldInfo.type !== 'number') {
      const mode = sizeIsDegree ? nodeSizeField : DEGREE_TOTAL;
      for (const n of nodeMap.values()) {
        if (mode === DEGREE_IN) n.sizeValue = n.inDegree;
        else if (mode === DEGREE_OUT) n.sizeValue = n.outDegree;
        else n.sizeValue = n.inDegree + n.outDegree;
      }
    }

    return { nodes: Array.from(nodeMap.values()), links };
  }, [rows, mapping, fieldsByName]);

  // Build color scale once per change in graph
  const colorScale = useMemo(() => {
    if (!mapping.nodeColorField) return null;
    const keys = Array.from(new Set(graph.nodes.map(n => n.colorKey).filter((v): v is string => v != null)));
    return d3.scaleOrdinal<string, string>().domain(keys).range(PALETTE);
  }, [graph.nodes, mapping.nodeColorField]);

  const sizeScale = useMemo(() => {
    const max = d3.max(graph.nodes, n => n.sizeValue) ?? 1;
    return d3.scaleSqrt().domain([0, Math.max(max, 1)]).range([6, 30]);
  }, [graph.nodes]);

  const weightScale = useMemo(() => {
    const max = d3.max(graph.links, l => l.weight) ?? 1;
    return d3.scaleLinear().domain([0, Math.max(max, 1)]).range([0.5, 6]);
  }, [graph.links]);

  // Main render
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    svg.selectAll('*').remove();

    // Arrow markers.
    // refX = 0 anchors the BACK of the arrowhead to the line endpoint, so the
    // arrowhead extends FORWARD from where the line ends. We shorten the line
    // by ARROW_LEN below so the arrowhead's tip lands right at the target
    // circle's perimeter — gives a clean "line → arrowhead → node" look
    // instead of an arrowhead pasted on top of the line.
    // `userSpaceOnUse` keeps them a constant pixel size regardless of stroke width.
    const ARROW_LEN = 10;
    const ARROW_HALF = 3.5;
    const defs = svg.append('defs');
    defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', `0 -${ARROW_HALF} ${ARROW_LEN} ${ARROW_HALF * 2}`)
      .attr('refX', 0)
      .attr('refY', 0)
      .attr('markerUnits', 'userSpaceOnUse')
      .attr('markerWidth', ARROW_LEN)
      .attr('markerHeight', ARROW_HALF * 2)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', `M0,-${ARROW_HALF}L${ARROW_LEN},0L0,${ARROW_HALF}z`)
      .attr('fill', '#9ca3af');

    defs.append('marker')
      .attr('id', 'arrow-selected')
      .attr('viewBox', `0 -${ARROW_HALF + 0.5} ${ARROW_LEN + 1} ${(ARROW_HALF + 0.5) * 2}`)
      .attr('refX', 0)
      .attr('refY', 0)
      .attr('markerUnits', 'userSpaceOnUse')
      .attr('markerWidth', ARROW_LEN + 1)
      .attr('markerHeight', (ARROW_HALF + 0.5) * 2)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', `M0,-${ARROW_HALF + 0.5}L${ARROW_LEN + 1},0L0,${ARROW_HALF + 0.5}z`)
      .attr('fill', '#06b6d4');

    const g = svg.append('g');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoom);

    const initialSpread = spreadRef.current;
    const sim = d3.forceSimulation<Node>(graph.nodes)
      .force('link', d3.forceLink<Node, Link>(graph.links).id(d => d.id).distance(BASE_LINK_DISTANCE * initialSpread).strength(0.5))
      .force('charge', d3.forceManyBody<Node>().strength(BASE_CHARGE_STRENGTH * initialSpread))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<Node>().radius(n => sizeScale(n.sizeValue) + 4));
    simRef.current = sim;

    const linkSel = g.append('g')
      .attr('class', 'links')
      .selectAll<SVGLineElement, Link>('line')
      .data(graph.links)
      .join('line')
      .attr('stroke', '#9ca3af')
      .attr('opacity', 0.7) // initial; selection effect overrides per-edge
      .attr('stroke-width', l => weightScale(l.weight))
      .attr('marker-end', 'url(#arrow)');

    // Edge labels — drawn at the midpoint and rotated to follow the edge.
    // Visibility is the AND of:
    //   · a label field is mapped and some links actually have text
    //   · mode allows it (auto = density cap, on = always, off = never)
    const EDGE_LABEL_DENSITY_CAP = 500;
    const labelsAvailable = !!mapping.edgeLabelField && graph.links.some(l => l.label);
    const showEdgeLabels = labelsAvailable && (
      edgeLabelMode === 'on'
        ? true
        : edgeLabelMode === 'off'
          ? false
          : graph.links.length <= EDGE_LABEL_DENSITY_CAP
    );

    const labelSel = showEdgeLabels
      ? g.append('g')
          .attr('class', 'edge-labels')
          .selectAll<SVGTextElement, Link>('text')
          .data(graph.links)
          .join('text')
          .text(l => l.label)
          .attr('text-anchor', 'middle')
          .attr('dy', -3)
          .attr('font-size', 9)
          .attr('fill', '#e5e7eb')
          .attr('paint-order', 'stroke')
          .attr('stroke', '#111827')
          .attr('stroke-width', 3)
          .style('pointer-events', 'none')
          .style('user-select', 'none')
      : null;

    const nodeSel = g.append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, Node>('g')
      .data(graph.nodes)
      .join('g')
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        event.stopPropagation();
        onNodeClick(d.id === selectedNode ? null : d.id);
      })
      .call(
        d3.drag<SVGGElement, Node>()
          .on('start', (event, d) => {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    nodeSel.append('circle')
      .attr('r', n => sizeScale(n.sizeValue))
      .attr('fill', n => colorScale && n.colorKey != null ? colorScale(n.colorKey) : '#60a5fa')
      .attr('stroke', '#fff')
      .attr('stroke-width', 1);

    nodeSel.append('text')
      .text(n => n.id)
      .attr('text-anchor', 'middle')
      .attr('dy', n => sizeScale(n.sizeValue) + 11)
      .attr('font-size', 10)
      .attr('fill', '#e5e7eb')
      .attr('paint-order', 'stroke')
      .attr('stroke', '#111827')
      .attr('stroke-width', 3)
      .style('pointer-events', 'none')
      .style('user-select', 'none');

    // Background click clears selection
    svg.on('click', () => onNodeClick(null));

    // Tooltips
    const tooltip = d3.select('body')
      .append('div')
      .style('position', 'absolute')
      .style('visibility', 'hidden')
      .style('background-color', 'rgba(0, 0, 0, 0.9)')
      .style('color', 'white')
      .style('padding', '6px 10px')
      .style('border-radius', '4px')
      .style('font-size', '12px')
      .style('pointer-events', 'none')
      .style('max-width', '420px')
      .style('z-index', '1000');

    nodeSel
      .on('mouseover', (event, d) => {
        const lines: string[] = [`<strong>${d.id}</strong>`];
        if (mapping.nodeColorField && d.colorKey != null) {
          lines.push(`${mapping.nodeColorField}: ${d.colorKey}`);
        }
        lines.push(`in: ${d.inDegree} · out: ${d.outDegree}`);
        if (mapping.nodeSizeField && fieldsByName.get(mapping.nodeSizeField)?.type === 'number') {
          lines.push(`${mapping.nodeSizeField}: ${d.sizeValue}`);
        }
        tooltip.html(lines.join('<br/>')).style('visibility', 'visible');
      })
      .on('mousemove', (event) => {
        tooltip.style('top', (event.pageY - 10) + 'px').style('left', (event.pageX + 12) + 'px');
      })
      .on('mouseout', () => tooltip.style('visibility', 'hidden'));

    linkSel
      .on('mouseover', (event, l) => {
        const srcId = typeof l.source === 'string' ? l.source : l.source.id;
        const tgtId = typeof l.target === 'string' ? l.target : l.target.id;
        const lines: string[] = [`<strong>${escapeHTML(srcId)} → ${escapeHTML(tgtId)}</strong>`];
        if (l.label && mapping.edgeLabelField) {
          lines.push(`<em style="color:#9ca3af">${escapeHTML(mapping.edgeLabelField)}:</em> <strong>${escapeHTML(l.label)}</strong>`);
        }
        if (mapping.edgeWeightField) lines.push(`<em style="color:#9ca3af">${escapeHTML(mapping.edgeWeightField)}:</em> ${l.weight}`);

        const skip = new Set([
          mapping.sourceField,
          mapping.targetField,
          mapping.edgeLabelField,
          // Auto-skip "noise" fields common in edge-list JSON:
          //   · <source>_label / <target>_label → redundant display copies of the IDs
          //   · legend_key_id                    → internal index, never user-facing
          `${mapping.sourceField}_label`,
          `${mapping.targetField}_label`,
          'legend_key_id',
        ].filter(Boolean) as string[]);
        const shown = new Set<string>();

        // First pass: pin any justification-like fields with content. These
        // get more characters and an italic label so they stand out.
        for (const f of fields) {
          if (skip.has(f.name) || !isJustificationField(f.name)) continue;
          const v = l.rawRow[f.name];
          if (v === null || v === undefined || v === '') continue;
          const text = truncate(String(v), 400);
          lines.push(`<div style="margin-top:4px"><em style="color:#9ca3af">${escapeHTML(f.name)}:</em><br/>${escapeHTML(text)}</div>`);
          shown.add(f.name);
        }

        // Second pass: fill with other non-empty fields up to a cap
        const MAX_OTHER = 6;
        let count = 0;
        for (const f of fields) {
          if (count >= MAX_OTHER) break;
          if (shown.has(f.name) || skip.has(f.name)) continue;
          const v = l.rawRow[f.name];
          if (v === null || v === undefined || v === '') continue;
          lines.push(`${escapeHTML(f.name)}: ${escapeHTML(truncate(fmt(v), 120))}`);
          count++;
        }

        tooltip.html(lines.join('<br/>')).style('visibility', 'visible');
      })
      .on('mousemove', (event) => {
        tooltip.style('top', (event.pageY - 10) + 'px').style('left', (event.pageX + 12) + 'px');
      })
      .on('mouseout', () => tooltip.style('visibility', 'hidden'));

    sim.on('tick', () => {
      // Stop the line short of the target circle by (radius + arrowhead length + 1px gap).
      // With marker refX=0, the arrowhead starts at the line endpoint and extends forward,
      // so its tip lands ~1px outside the target circle — clean line → arrow → node.
      linkSel
        .attr('x1', l => (l.source as Node).x ?? 0)
        .attr('y1', l => (l.source as Node).y ?? 0)
        .attr('x2', l => {
          const s = l.source as Node;
          const t = l.target as Node;
          const dx = (t.x ?? 0) - (s.x ?? 0);
          const dy = (t.y ?? 0) - (s.y ?? 0);
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const r = sizeScale(t.sizeValue) + ARROW_LEN + 1;
          // Safety: don't let the line invert when nodes overlap
          const offset = Math.min(r, dist);
          return (t.x ?? 0) - (dx / dist) * offset;
        })
        .attr('y2', l => {
          const s = l.source as Node;
          const t = l.target as Node;
          const dx = (t.x ?? 0) - (s.x ?? 0);
          const dy = (t.y ?? 0) - (s.y ?? 0);
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const r = sizeScale(t.sizeValue) + ARROW_LEN + 1;
          const offset = Math.min(r, dist);
          return (t.y ?? 0) - (dy / dist) * offset;
        });

      nodeSel.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`);

      // Position edge labels at the midpoint, rotated to follow the edge.
      // Flip when the natural angle would render text upside-down.
      if (labelSel) {
        labelSel.attr('transform', l => {
          const s = l.source as Node;
          const t = l.target as Node;
          const sx = s.x ?? 0, sy = s.y ?? 0;
          const tx = t.x ?? 0, ty = t.y ?? 0;
          const cx = (sx + tx) / 2;
          const cy = (sy + ty) / 2;
          let angle = Math.atan2(ty - sy, tx - sx) * 180 / Math.PI;
          if (angle > 90 || angle < -90) angle += 180;
          return `translate(${cx},${cy}) rotate(${angle})`;
        });
      }
    });

    return () => {
      sim.stop();
      simRef.current = null;
      tooltip.remove();
    };
  }, [graph, colorScale, sizeScale, weightScale, mapping, fields, fieldsByName, onNodeClick, edgeLabelMode]);
  // selectedNode handled by a separate effect below to avoid restarting the simulation on selection

  // Spread control — retune the existing simulation's link/charge forces
  // without rebuilding the SVG. Wakes the simulation with a small alpha kick.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const linkForce = sim.force('link') as d3.ForceLink<Node, Link> | undefined;
    const chargeForce = sim.force('charge') as d3.ForceManyBody<Node> | undefined;
    if (linkForce) linkForce.distance(BASE_LINK_DISTANCE * spread);
    if (chargeForce) chargeForce.strength(BASE_CHARGE_STRENGTH * spread);
    sim.alpha(0.3).restart();
  }, [spread]);

  // Selection + chain-highlight rendering (without rebuilding the simulation).
  // Three exclusive cases:
  //   1. chain highlight active (highlightedNodes set, optionally with specific
  //      edges in highlightedEdgeKeys) → dim outside, brighten inside
  //   2. node selected but no chain → highlight direct neighbours (legacy)
  //   3. nothing selected → default neutral palette
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);

    const isLinkInChain = (l: Link): boolean => {
      if (!highlightedEdgeKeys) return false;
      return highlightedEdgeKeys.has(l.edgeKey);
    };
    const nodeInHighlight = (id: string): boolean =>
      !highlightedNodes || highlightedNodes.has(id);
    const linkInHighlight = (l: Link): boolean => {
      if (!highlightedNodes) return true;
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;
      return highlightedNodes.has(sId) && highlightedNodes.has(tId);
    };

    // The "interactive subnetwork" is wider than the visual highlight: it
    // determines which nodes/edges still respond to hover. In chain mode we
    // reuse the highlight set; in plain node-selection mode we include the
    // selected node plus its direct neighbours (so tooltips work on what
    // you're actually looking at, not on the dense background you're not).
    let interactiveNodes: Set<string> | null = null;
    if (highlightedNodes) {
      interactiveNodes = highlightedNodes;
    } else if (selectedNode) {
      interactiveNodes = new Set<string>([selectedNode]);
      svg.selectAll<SVGLineElement, Link>('g.links line').each(function(l) {
        const sId = typeof l.source === 'string' ? l.source : l.source.id;
        const tId = typeof l.target === 'string' ? l.target : l.target.id;
        if (sId === selectedNode) interactiveNodes!.add(tId);
        else if (tId === selectedNode) interactiveNodes!.add(sId);
      });
    }
    const isNodeInteractive = (id: string): boolean =>
      !interactiveNodes || interactiveNodes.has(id);
    const isLinkInteractive = (l: Link): boolean => {
      if (!interactiveNodes) return true;
      const sId = typeof l.source === 'string' ? l.source : l.source.id;
      const tId = typeof l.target === 'string' ? l.target : l.target.id;
      return interactiveNodes.has(sId) && interactiveNodes.has(tId);
    };

    // Node circles: dim everything outside the focus subnetwork (chain mode
    // OR selected+neighbours in plain selection). When nothing is selected,
    // interactiveNodes is null so all nodes stay at full opacity.
    svg.selectAll<SVGCircleElement, Node>('g.nodes g circle')
      .attr('stroke', d => d.id === selectedNode ? '#06b6d4' : '#fff')
      .attr('stroke-width', d => d.id === selectedNode ? 3 : 1)
      .attr('opacity', d => isNodeInteractive(d.id) ? 1 : 0.12);

    // Node labels: hide entirely on out-of-focus nodes (display:none rather
    // than just fading), so the focused subnetwork's labels read cleanly
    // without leftover ghost text from the background.
    svg.selectAll<SVGTextElement, Node>('g.nodes g text')
      .style('display', d => isNodeInteractive(d.id) ? null : 'none');

    // Disable pointer events on nodes outside the interactive subnetwork
    // (chain highlight set OR selected node + direct neighbours). This stops
    // unrelated tooltips from firing and occluding the area you're focused
    // on. When nothing is selected, interactiveNodes is null and everything
    // stays interactive.
    svg.selectAll<SVGGElement, Node>('g.nodes > g')
      .style('pointer-events', d => isNodeInteractive(d.id) ? null : 'none');

    svg.selectAll<SVGLineElement, Link>('g.links line')
      .attr('stroke', l => {
        // Chain edge wins
        if (isLinkInChain(l)) return '#06b6d4';
        if (highlightedNodes) return linkInHighlight(l) ? '#9ca3af' : '#374151';
        if (!selectedNode) return '#9ca3af';
        const sId = typeof l.source === 'string' ? l.source : l.source.id;
        const tId = typeof l.target === 'string' ? l.target : l.target.id;
        return sId === selectedNode || tId === selectedNode ? '#06b6d4' : '#374151';
      })
      // `opacity` rather than `stroke-opacity` so that the dimming applies to
      // the marker-end arrowhead too — `stroke-opacity` only touches the line
      // itself, leaving solid arrowheads floating on top of dimmed edges.
      .attr('opacity', l => {
        if (isLinkInChain(l)) return 1;
        if (highlightedNodes) return linkInHighlight(l) ? 0.7 : 0.05;
        if (!selectedNode) return 0.7;
        const sId = typeof l.source === 'string' ? l.source : l.source.id;
        const tId = typeof l.target === 'string' ? l.target : l.target.id;
        return sId === selectedNode || tId === selectedNode ? 1 : 0.1;
      })
      .attr('marker-end', l => {
        if (isLinkInChain(l)) return 'url(#arrow-selected)';
        if (highlightedNodes && !linkInHighlight(l)) return 'url(#arrow)';
        if (!selectedNode) return 'url(#arrow)';
        const sId = typeof l.source === 'string' ? l.source : l.source.id;
        const tId = typeof l.target === 'string' ? l.target : l.target.id;
        return sId === selectedNode || tId === selectedNode ? 'url(#arrow-selected)' : 'url(#arrow)';
      })
      .style('pointer-events', l => isLinkInteractive(l) ? null : 'none');

    // Edge labels — visibility follows the focus subnetwork. When a node is
    // selected, only labels for edges touching the focus (the active chain
    // OR edges between selected+neighbour nodes) stay visible; everything
    // else is fully hidden. Reverts to default on deselection.
    svg.selectAll<SVGTextElement, Link>('g.edge-labels text')
      .style('display', l => {
        if (!selectedNode) return null;        // no selection → show per user's mode
        if (isLinkInChain(l)) return null;     // chain edges keep their label
        if (isLinkInteractive(l)) return null; // edges in focus subnetwork keep theirs
        return 'none';                          // everything else hidden
      })
      .attr('opacity', l => {
        if (isLinkInChain(l)) return 1;
        if (highlightedNodes) return linkInHighlight(l) ? 0.9 : 0.05;
        return 0.9;
      });
  }, [selectedNode, highlightedNodes, highlightedEdgeKeys]);

  // Legend for color scale
  const legendItems = useMemo(() => {
    if (!colorScale || !mapping.nodeColorField) return [];
    return colorScale.domain().slice(0, 12).map(k => ({ key: k, color: colorScale(k) }));
  }, [colorScale, mapping.nodeColorField]);

  return (
    <div className="relative w-full h-full">
      <svg ref={svgRef} className="w-full h-full bg-gray-950" />
      <div className="absolute top-2 left-2 bg-gray-900/70 backdrop-blur-sm rounded px-3 py-2 text-xs">
        <div className="text-gray-400">
          {graph.nodes.length} nodes · {graph.links.length} edges
        </div>
        {mapping.edgeLabelField && edgeLabelMode === 'auto' && graph.links.length > 500 && (
          <div className="text-amber-400/80 text-[10px] mt-1">
            edge labels auto-hidden ({'>'}500 edges) — toggle "on" in Layout to force
          </div>
        )}
        {legendItems.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-700">
            <div className="text-gray-500 text-[10px] uppercase tracking-wider mb-1">
              {mapping.nodeColorField}
            </div>
            <div className="flex flex-wrap gap-1 max-w-xs">
              {legendItems.map(item => (
                <div key={item.key} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ background: item.color }} />
                  <span className="text-gray-300">{item.key}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-gray-500 bg-gray-900/70 backdrop-blur-sm rounded px-3 py-1">
        click nodes · drag to move · scroll to zoom
      </div>
    </div>
  );
}
