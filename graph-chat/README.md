# graph-chat

Ask questions about a loaded `Graph_Viz.json` in plain English. Answers are
drawn from that file alone; nothing is fetched from the internet.

Reached from the **Ask about this graph** button in the Visualizer sidebar,
which opens a wide view with a question box, past questions, charts and the
matching triplets with their media.

---

## Setup

### 1. A model

Any one of four. Ollama runs locally and needs no key.

| model | key variable | default model id |
|---|---|---|
| Ollama | none | `llama3.1` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Gemini | `GEMINI_API_KEY` | `gemini-2.0-flash` |
| Claude | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |

For Ollama, pull a model once:

```powershell
ollama pull llama3.1
```

### 2. Keys

Copy `graph-chat/server/.env.example` to `graph-chat/server/.env` and fill in
the variables above. The service reads `.env` or `process.env` from that folder
at startup and prints the variable names it loaded. A variable already set in
the shell takes precedence over the file.

| variable | purpose | default |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI | — |
| `GEMINI_API_KEY` | Gemini | — |
| `ANTHROPIC_API_KEY` | Claude | — |
| `OLLAMA_HOST` | where the local daemon listens | `http://127.0.0.1:11434` |
| `GRAPH_CHAT_PORT` | service port | `3002` |
| `GRAPH_CHAT_DB` | database file | `graph-chat/server/data/` |
| `GRAPH_CHAT_ALLOWED_ORIGIN` | CORS origin | `*` |
| `VITE_GRAPH_CHAT_URL` | where the viewer looks for the service | `http://localhost:3002` |

To move the service to another port, set `GRAPH_CHAT_PORT` in the terminal that
starts it and `VITE_GRAPH_CHAT_URL` in `network-ui\.env` to the same port.

---

## Running

**Service** — repo root:

```powershell
npx tsx graph-chat/server/main.ts
```

Prints the port it bound and which models are available.

**Viewer** — second terminal:

```powershell
cd network-ui
npm run dev
```

**Ollama** — third terminal, if using it:

```powershell
ollama serve
```

Open http://localhost:5173/, choose a dataset, then **Ask about this graph** in
the left sidebar.

---

## How it works

**Ingest.** The loaded graph is normalised into one triplet record per
`triplet_id`. A `Graph_Viz.json` carries one TRIPLET node per (triplet,
category) pair, so the node count is larger than the triplet count; the triplet
count is what the answers use.

**Grouping.** Triplets are grouped by `cluster_id`, the id of the originating
message, shared by every triplet extracted from it. Where a file carries no
`cluster_id`, the message text is used instead, and the view states which key
was used.

**Matching.** A BM25 index over `subject`, `predicate`, `object`, `label`,
`msg_text`, `justification`, the media descriptions, `attributes` and
`event_name`. Terms are stemmed, so singular and plural forms match. Retrieval
also applies trigram fuzzy matching for near-spellings. Everything runs in the
browser; no query text leaves the machine.

**Answering.** The figures and counts come from the index directly. The model
receives the evidence and writes the summary sentence over it. Charts are drawn
from the same evidence.

**Caching.** Each answer is stored with its question and the graph it was asked
of. A later question scoring above 0.76 similarity against a stored one, on the
same graph, is served from the store. The cache is shared across viewers.

**Display.** The first 25 results are rendered; the complete set stays in memory
and is what counts, charts and exports are computed from.

---

## Architecture

| folder | contents |
|---|---|
| `graph-chat/engine/` | ingest, index, matching, aggregation. No network, no model calls, runs in the browser and in the service |
| `graph-chat/server/` | HTTP service, answer store, question cache, model adapters |
| `network-ui/src/components/graphchat/` | the wide view |

Endpoints are under `/api/graph-chat`: `GET /health`, `GET /providers`,
`GET /preprompt`, `POST /ask`, `GET /history`, `GET /answer/:id`.

The viewer runs without the service. Matching, counting, charts and results are
computed in the browser; the service adds the written summary, the shared
question history and the cache.
