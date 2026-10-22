"""Independent id-divergence probe.

WHY IT IS PYTHON AND WHY IT IMPORTS NOTHING OF OURS
    It exists to falsify the grouping fix, so it must not share a line with
    it. It parses the file itself, with the standard library only, and knows
    nothing about the engine's ingest, its collapse, or its grouping. If it
    agreed with the engine because both ran the same code, it would prove
    nothing.

WHAT IT ANSWERS
    1. How many distinct triplet_id / cluster_id / record_id a corpus holds.
    2. Whether the two candidate grouping keys DISAGREE: does any one
       cluster_id (message) span more than one record_id (row)? That is the
       multi-attachment case, and it is the only case where grouping on
       record_id splits one message into several groups.
    3. What grouping by each key would produce, counted over DISTINCT
       TRIPLETS so the node-per-category duplication cannot inflate it.

    usage: python3 -I idcheck.py <graph json> [<graph json> ...]
"""

import json
import sys
from collections import defaultdict


def triple_bearing(node):
    s = node.get("subject")
    o = node.get("object")
    return isinstance(s, str) and s.strip() != "" and isinstance(o, str) and o.strip() != ""


def source_nodes(nodes):
    """The nodes that carry a triple, under either shape, decided here from
    scratch: TRIPLET nodes if the file has any, else category nodes that
    carry a triple."""
    triplets = [n for n in nodes if n.get("hierarchy") == "TRIPLET"]
    if triplets:
        return triplets, "contract"
    cat = [n for n in nodes
           if isinstance(n.get("hierarchy"), str)
           and n["hierarchy"].startswith("H")
           and n["hierarchy"][1:].isdigit()
           and triple_bearing(n)]
    return cat, "legacy"


def nonempty(v):
    return v.strip() if isinstance(v, str) and v.strip() != "" else None


def report(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    nodes = data.get("nodes") or []
    src, shape = source_nodes(nodes)

    print("=" * 72)
    print("file   ", path)
    print("shape  ", shape, " (decided independently of the engine)")
    print("nodes  ", len(nodes), " source nodes", len(src))

    # Identity per SOURCE NODE first, then collapsed to distinct triplets.
    per_triplet = {}          # triplet key -> {"cluster": set, "record": set}
    field_present = defaultdict(int)
    for n in src:
        tid = nonempty(n.get("triplet_id"))
        key = tid if tid else "syn:%d" % id(n)
        rec = per_triplet.setdefault(key, {"cluster": set(), "record": set()})
        cid = nonempty(n.get("cluster_id"))
        rid = nonempty(n.get("record_id"))
        if cid:
            rec["cluster"].add(cid)
        if rid:
            rec["record"].add(rid)
        for f in ("triplet_id", "cluster_id", "record_id", "msg_id",
                  "reference_key", "msg_text", "text_msg"):
            if nonempty(n.get(f)):
                field_present[f] += 1

    print()
    print("  field presence over source nodes")
    for f in ("triplet_id", "cluster_id", "record_id", "msg_id",
              "reference_key", "msg_text", "text_msg"):
        print("    %-14s %6d / %d" % (f, field_present[f], len(src)))

    all_clusters = set()
    all_records = set()
    for v in per_triplet.values():
        all_clusters |= v["cluster"]
        all_records |= v["record"]

    print()
    print("  distinct triplet_id (collapsed) %6d" % len(per_triplet))
    print("  distinct cluster_id             %6d" % len(all_clusters))
    print("  distinct record_id              %6d" % len(all_records))

    # THE DIVERGENCE TEST. One message spanning several rows is the case
    # where the two keys give different answers.
    cluster_to_records = defaultdict(set)
    cluster_to_triplets = defaultdict(set)
    record_to_triplets = defaultdict(set)
    no_cluster = 0
    no_record = 0
    for key, v in per_triplet.items():
        if not v["cluster"]:
            no_cluster += 1
        if not v["record"]:
            no_record += 1
        for c in v["cluster"]:
            cluster_to_triplets[c].add(key)
            for r in v["record"]:
                cluster_to_records[c].add(r)
        for r in v["record"]:
            record_to_triplets[r].add(key)

    record_to_clusters = defaultdict(set)
    for c, rs in cluster_to_records.items():
        for r in rs:
            record_to_clusters[r].add(c)

    multi = {c: rs for c, rs in cluster_to_records.items() if len(rs) > 1}
    multi_rev = {r: cs for r, cs in record_to_clusters.items() if len(cs) > 1}
    print()
    print("  triplets with NO cluster_id     %6d" % no_cluster)
    print("  triplets with NO record_id      %6d" % no_record)
    print("  cluster_ids spanning >1 record_id %4d   <-- THE DIVERGENCE" % len(multi))
    if multi:
        for c, rs in list(sorted(multi.items()))[:5]:
            print("      cluster %s -> %d rows: %s" % (c, len(rs), ", ".join(sorted(rs))[:90]))
    else:
        print("      none in this file: no message here has two attachments.")
    print("  record_ids spanning >1 cluster_id  %4d" % len(multi_rev))
    if (len(all_clusters) == len(all_records) and not multi and not multi_rev
            and all_clusters):
        print("      cluster <-> record is a BIJECTION on this file, so the two")
        print("      keys give identical groups on ANY subset of it, including")
        print("      the subset any one question matches. The divergence cannot")
        print("      be observed here at all.")

    # What each key would produce, over distinct triplets.
    print()
    print("  grouping over distinct triplets")
    print("    groups by cluster_id          %6d" % len(cluster_to_triplets))
    print("    groups by record_id           %6d" % len(record_to_triplets))
    biggest_c = max((len(v) for v in cluster_to_triplets.values()), default=0)
    biggest_r = max((len(v) for v in record_to_triplets.values()), default=0)
    print("    largest cluster group         %6d triplets" % biggest_c)
    print("    largest record group          %6d triplets" % biggest_r)
    if cluster_to_triplets and record_to_triplets:
        delta = len(record_to_triplets) - len(cluster_to_triplets)
        print("    record_id makes %d MORE group(s) than cluster_id" % delta)
        print("    -> %s" % ("a message IS being split; grouping on record_id compounds"
                             if delta > 0 else
                             "the two keys agree on this file"))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    for p in sys.argv[1:]:
        report(p)
    print("=" * 72)
    return 0


if __name__ == "__main__":
    sys.exit(main())
