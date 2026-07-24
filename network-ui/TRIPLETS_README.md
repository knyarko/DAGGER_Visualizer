# DAGGER Visualizer

An interactive web app for exploring **causal-link and relationship graphs** extracted from a document corpus. Drop in a CSV or JSON file, choose which columns become the nodes and edges, and the app renders a live, force-directed network you can pan, zoom, filter, and walk through hop by hop.

The flagship dataset is a set of **causal triplets** — *subject → predicate → object* — but the explorer is general: any tabular or graph-shaped data with a "from" and a "to" column will render.

🔗 **Live app:** https://knyarko.github.io/DAGGER_Visualizer/
📦 **Repo:** https://github.com/knyarko/DAGGER_Visualizer

---

## What it does

The app opens to an upload screen. Once you load data, you get a three-panel workspace:

- **Left panel** — dataset info, layout/timeline/topology controls, and per-field filters
- **Center** — the directed network graph itself (drag, zoom, click)
- **Right panel** — the field mapping (which columns drive what) and a detail view for whatever node you've selected

You don't need to write any code or configure anything up front. The app inspects your file, guesses sensible defaults, and draws the graph immediately. Everything after that is adjustment.

---

## Getting started

### Try it without any data

On the upload screen, click the **"Crisis MD Causal Triplets"** sample under *Or try a sample*. This loads a built-in dataset of causal relationships extracted from the CrisisMMD collection — thousands of annotated tweets and images from seven major 2017 natural disasters (earthquakes, hurricanes, wildfires, floods). It's the fastest way to see what the tool does.

### Load your own data

Drag a file onto the drop zone, or click to browse. Accepted formats:

- **CSV** with a header row (quoted fields and escaped quotes are handled)
- **JSON array** of flat objects — e.g. `[{"src":"A","dst":"B", ...}, ...]`
- **JSON wrapper objects** with a `data`, `rows`, `items`, or `links` array
- **JSON graph objects** with multiple arrays — e.g. `{"nodes":[...], "edges":[...]}`. When a file has more than one array, the app asks which one to visualize (see *Working with node + edge files* below).

If a file contains both `nodes` and `edges`, the app automatically uses the **edges** to draw the graph and keeps the **nodes** as a lookup table for rich per-node detail — you don't have to merge them yourself.

---

## The graph canvas

Once data loads, the center panel shows the network. Each **node** is an entity; each **arrow** is a directed relationship pointing from source to target.

- **Pan** — drag empty space
- **Zoom** — scroll wheel (or pinch)
- **Reposition a node** — drag it; it stays where you drop it so you can untangle a cluster
- **Inspect a node** — click it. The node and its detail open in the right panel, and its direct relationships are listed.
- **Follow a connection** — in the relationship list, click a connected entity's name to jump your selection to it

Node **size** and **color**, and edge **width** and **labels**, are all driven by the field mapping you can change at any time (see below).

---

## Controls

### Layout → Spread

A single slider that pulls the graph apart or packs it together. Dense, hairball-like clusters become readable when you increase spread; sprawling sparse graphs tighten up when you decrease it. Defaults to ×1.0; hit **reset** to return.

### Edge labels

Toggle relationship labels (the predicate / action text) on the arrows:

- **auto** — labels appear automatically when the graph is small enough to stay legible (below ~500 edges), and hide on denser graphs
- **on** — always show labels
- **off** — never show labels

### Timeline

If your nodes carry event dates, a **Timeline** section appears. Click **Enable timeline** to get a date slider with a play/pause button.

As the cursor advances, each node **appears on its event date**, stays fully visible briefly, then **fades out over 30 days**; once a node has fully faded, any edge touching it disappears too. This lets you watch a network build up and dissolve over time rather than seeing everything at once. Press **play** to animate the whole span automatically, or drag the slider to scrub to any date.

> **Note on dates:** the timeline reads each node's `day` / `month` / `year` fields (the actual event date). It deliberately ignores a generic `timestamp` field, because in this data `timestamp` records *when a record was accessed*, not when the underlying event happened. Nodes with no resolvable date stay visible the whole time, so an undated dataset is never silently emptied.

### Topology → Min node degree (k-core)

A slider (k = 0–5) that strips away weakly-connected nodes. At k = 1 it removes isolated nodes; higher values iteratively peel off everything that isn't part of a denser, multiply-connected core. This is the quickest way to cut a noisy graph down to its structurally important backbone. The panel shows how many edges were pruned. k = 0 turns it off.

### Filters (per field)

Every column in your data gets its own filter, with the right control chosen automatically for the field type:

- **Categorical** (small set of values) — checkboxes with per-value counts; toggle "all" / "none"
- **Numeric** — a min/max range slider
- **Date** — a from/to date range
- **Free text / high-cardinality** — a search box with a frequency-sorted dropdown of values

Active filters are highlighted, stack together, and update the graph live. **reset all** clears them at once. Below the graph's row count you can see how many rows survive your filters (and the k-core, if active).

---

## Field mapping (right panel → "Mapping")

This is how you tell the app what your columns *mean*. The app makes an educated first guess by matching common column names (`source`/`from`/`subject`/`actor`, `target`/`to`/`object`, `predicate`/`action`/`label`, etc.), but you can override any of it:

| Mapping | What it controls |
|---|---|
| **Source (from)** | which column is the edge's origin node *(required)* |
| **Target (to)** | which column is the edge's destination node *(required)* |
| **Edge label** | text shown on/over each arrow |
| **Node color by** | color nodes by a categorical field (discrete palette) |
| **Node size by** | size nodes by **centrality** (total / incoming / outgoing connections) or by a numeric field |
| **Edge weight by** | a numeric field that drives arrow stroke width |

Centrality-based sizing is the default, so the most-connected entities stand out immediately.

---

## Tracing causal chains

When you've selected a node, the right panel offers a **Chain depth** slider (1–5 hops). This is the core feature for causal-link exploration: instead of just showing direct neighbors, it walks the graph outward and enumerates the actual **paths** through it.

- Choose **downstream →** to follow arrows *out* of the node (what it leads to / causes)
- Choose **← upstream** to follow arrows *into* the node (what leads to / causes it)

The panel lists every chain it finds, longest first, with each path shown as a sequence of entities connected by arrows. Click a chain to **isolate it** — the rest of the graph dims and just that path is highlighted in cyan — then use **prev / next** to step through chains one at a time, or **show all** to light up the entire reachable neighborhood again.

This turns "who is connected to whom" into "show me every route by which A could have influenced B."

---

## Node detail

Clicking a node opens its detail in the right panel. For datasets that carry a rich `all_info` (or `info`) field — like the causal-triplet data — this renders the formatted card the pipeline produced: the subject → predicate → object relationship, the original source text, category tags, dates, and any image thumbnails. Below that, you get the node's direct relationships (or its chains, if chain mode is on).

---

## Working with node + edge files

Many graph files store nodes and edges as two separate arrays in one JSON object:

```json
{
  "nodes": [
    { "node": "id_001", "label": "FC Barcelona", "category": "MISC",
      "subject": "FC Barcelona", "predicate": "shows solidarity with",
      "object": "earthquake victims", "year": 2017, "month": 9, "day": 20,
      "all_info": "<...formatted HTML...>" }
  ],
  "edges": [
    { "source": "id_001", "target": "id_002",
      "source_label": "FC Barcelona", "target_label": "MISC",
      "predicate": "shows solidarity with" }
  ]
}
```

When the app sees this, it:

1. Asks which array to visualize (a **Sources** picker appears in the left panel), defaulting to the edge list since that's what defines the connections.
2. **Auto-joins** the node array behind the scenes, keyed by node id, so clicking any node in the edge-driven graph still surfaces that node's full attributes, dates, and `all_info` card.

You can switch which array is being drawn at any time via the **Sources** button; the mapping and filters reset to fit whichever array you pick.

---

## Running locally

Requires a recent Node.js (18+) and npm.

```bash
git clone https://github.com/knyarko/DAGGER_Visualizer.git
cd DAGGER_Visualizer/network-ui
npm install
npm run dev
```

Then open the URL Vite prints (typically http://localhost:5173/).

Other scripts:

| Command | What it does |
|---|---|
| `npm run dev` | start the dev server with hot reload |
| `npm run build` | production build (outputs to `dist/`) |
| `npm run preview` | serve the production build locally |
| `npm run lint` | run ESLint |

### Building for deployment

The production build sets its base path to `/DAGGER_Visualizer/` to match the GitHub Pages URL. For a fork under a different repo name, override it:

```bash
BASE_PATH=/my-fork/ npm run build
```

In dev mode the base path is always `/`, so local runs need no configuration.

---

## Built with

React 19 · TypeScript · Vite · D3 (force layout, zoom, drag) · Tailwind CSS

---

## Notes & limitations

- The graph and all extracted relationships are produced by automated (LLM-based) extraction from source documents, so **errors and omissions are expected**. Where a dataset includes source documents, the detail view lets you check a relationship against its original text and judge accuracy for yourself.
- Very large graphs (tens of thousands of edges) will render, but edge labels auto-hide and the layout is heavier — use the **k-core** and **filter** controls to focus on the part you care about.
- The app keeps everything in the browser; your uploaded file isn't sent anywhere.