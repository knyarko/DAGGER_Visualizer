#!/usr/bin/env python3
"""
transform_graph.py — prepare a DAGGER causal-graph JSON for the visualizer.

What it does
------------
1. Leaves the `nodes` array completely untouched.
2. Rewrites the `edges` array so each edge is self-explanatory:
     · source_label  ->  the SOURCE node's full triplet  (subject predicate object)
     · target_label  ->  the TARGET node's full triplet  (subject predicate object)
   Instead of the cryptic short ids ("FLD917LK") you now read the actual
   relationship ("Earthquake causes destruction in Mexico City").
3. Drops the fields that are now redundant / baked into the labels:
     · triplet_a
     · triplet_b
     · causal_relationship   (e.g. "B_causes_A")

Everything else on each edge (legend_key_id, source, target, probability,
justification, predicate, hierarchy_link, ...) is preserved as-is.

Label building & fallbacks
--------------------------
For each endpoint we look the node up by id (the edge's source/target value)
and build "subject predicate object", skipping any empty part. If a node has
no triplet (e.g. a category/hierarchy node like "misc_h001"), we fall back, in
order, to:  node.label  ->  the edge's existing *_label  ->  the raw id.

Usage
-----
    python3 transform_graph.py INPUT.json [OUTPUT.json]

Defaults to reading Causal_Relationship_Graph_Viz.json in the current dir and
writing Causal_Relationship_Graph_Viz.prepared.json next to it.
"""

import json
import sys
from pathlib import Path

# Edge fields that become redundant once labels carry the full triplet.
DROP_FIELDS = ("triplet_a", "triplet_b", "causal_relationship")

# Where the source/target ids live on an edge, and the id field on a node.
NODE_ID_CANDIDATES = ("node", "id", "node_id", "nodeId", "name", "key")


def find_node_id_field(nodes):
    """Pick the field that holds each node's unique id (matches the viz heuristic)."""
    if not nodes:
        return "node"
    sample = nodes[: min(len(nodes), 50)]
    for cand in NODE_ID_CANDIDATES:
        present = sum(
            1 for n in sample if n.get(cand) not in (None, "")
        )
        if present >= len(sample) * 0.9:
            return cand
    return "node"


def build_spo(node):
    """Join subject + predicate + object into one readable sentence, skipping blanks."""
    if not node:
        return ""
    parts = []
    for field in ("subject", "predicate", "object"):
        v = node.get(field)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            parts.append(s)
    return " ".join(parts).strip()


def label_for(node_id, node, existing_label):
    """Full triplet, else node.label, else the edge's old label, else the raw id."""
    spo = build_spo(node)
    if spo:
        return spo
    if node and str(node.get("label", "")).strip():
        return str(node["label"]).strip()
    if existing_label not in (None, ""):
        return str(existing_label)
    return str(node_id)


def transform(data):
    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    id_field = find_node_id_field(nodes)
    by_id = {}
    for n in nodes:
        nid = n.get(id_field)
        if nid not in (None, ""):
            by_id[str(nid)] = n

    stats = {
        "edges": len(edges),
        "source_from_spo": 0,
        "target_from_spo": 0,
        "source_fallback": 0,
        "target_fallback": 0,
        "dropped_field_hits": {f: 0 for f in DROP_FIELDS},
    }

    new_edges = []
    for e in edges:
        # Count/strip the redundant fields.
        for f in DROP_FIELDS:
            if f in e:
                stats["dropped_field_hits"][f] += 1

        src_id = e.get("source")
        tgt_id = e.get("target")
        src_node = by_id.get(str(src_id))
        tgt_node = by_id.get(str(tgt_id))

        src_label = label_for(src_id, src_node, e.get("source_label"))
        tgt_label = label_for(tgt_id, tgt_node, e.get("target_label"))

        stats["source_from_spo" if build_spo(src_node) else "source_fallback"] += 1
        stats["target_from_spo" if build_spo(tgt_node) else "target_fallback"] += 1

        # Rebuild the edge preserving field order, minus the dropped fields,
        # with the two labels swapped for their full-sentence versions.
        new_edge = {}
        for k, v in e.items():
            if k in DROP_FIELDS:
                continue
            if k == "source_label":
                new_edge[k] = src_label
            elif k == "target_label":
                new_edge[k] = tgt_label
            else:
                new_edge[k] = v
        # If an edge somehow lacked the label keys, add them in a sensible spot.
        if "source_label" not in new_edge:
            new_edge["source_label"] = src_label
        if "target_label" not in new_edge:
            new_edge["target_label"] = tgt_label

        new_edges.append(new_edge)

    out = dict(data)          # keep any other top-level keys untouched
    out["nodes"] = nodes      # nodes passed through unchanged
    out["edges"] = new_edges
    return out, stats


def main():
    in_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("Causal_Relationship_Graph_Viz.json")
    if len(sys.argv) > 2:
        out_path = Path(sys.argv[2])
    else:
        out_path = in_path.with_suffix("")  # strip .json
        out_path = out_path.with_name(out_path.name + ".prepared.json")

    # Force UTF-8 on both ends. Windows defaults to cp1252, which can't encode
    # characters like curly quotes, emoji, or accented text and raises
    # UnicodeEncodeError on write; being explicit makes this portable.
    data = json.loads(in_path.read_text(encoding="utf-8"))
    out, stats = transform(data)
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Read   {in_path}")
    print(f"Wrote  {out_path}")
    print(f"  edges processed:          {stats['edges']}")
    print(f"  source_label from triplet: {stats['source_from_spo']}  (fallback: {stats['source_fallback']})")
    print(f"  target_label from triplet: {stats['target_from_spo']}  (fallback: {stats['target_fallback']})")
    for f, c in stats["dropped_field_hits"].items():
        print(f"  dropped {f}: {c} edges")


if __name__ == "__main__":
    main()