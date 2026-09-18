import { createReadStream, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// ── AA050: the configured media folders, served by the server already running ─
//
// Rusty: "please make it work without use of urls." So `src/lib/mediaRoots.json`
// holds FILESYSTEM PATHS and nothing else — no http://, no host, no port. A
// browser cannot read `C:\...` from a page, so those bytes still have to arrive
// over HTTP; the plugin below is what carries them, using the dev/preview server
// that is already running rather than a second one nobody wants to start.
//
// Entry `i` of `mediaRoots.json` is served at `/__media/<i>/`. That prefix is
// named here AND in `src/lib/mediaConfig.ts`; the two must agree.
//
// NOTHING IS EVER WRITTEN, MOVED OR COPIED. This is read-only, GET/HEAD only,
// one file at a time, and it refuses to leave the configured folder.

/** Must equal `MEDIA_MOUNT` in `src/lib/mediaConfig.ts`. */
const MEDIA_MOUNT = '/__media'

/** Where the folders are listed. The same file the client reads. */
const MEDIA_ROOTS_FILE = 'src/lib/mediaRoots.json'

/**
 * Read the configured folders. Re-read per request, deliberately: correcting a
 * misspelled folder is then a save and a refresh, not a dev-server restart. The
 * file is two lines long and only media requests touch it.
 *
 * Every way a hand-edited file can be wrong ends in an empty list, never a
 * throw: a dev server that dies because a config line has a stray comma is a
 * worse failure than a media card that says it could not find the folder.
 */
function readMediaRoots(projectRoot: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(projectRoot, MEDIA_ROOTS_FILE), 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.map(entry => (typeof entry === 'string' ? entry.trim() : ''))
  } catch {
    return []
  }
}

/** Content types for what this corpus actually holds, plus the obvious
 *  neighbours. An unknown extension is still served — as bytes, which is what
 *  `application/octet-stream` means — rather than refused. */
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
}

/**
 * Resolve one relative media path inside one configured folder.
 *
 * THE JOIN RULE. A DAGGER `media[].path` is relative to `crisis_triplets` and
 * already reads `resources/test_files/datasets/...`, while a configured folder
 * may point deep into that same tree. So the root's TAIL and the path's HEAD
 * OVERLAP — they are not concatenated. The longest run of trailing segments the
 * root already ends with is consumed from the front of the path; what is left is
 * appended.
 *
 * Every valid overlap is tried, longest first, and the first candidate that is
 * actually a file on disk wins. Checking disk is what keeps a coincidental
 * overlap (a root ending `/images` and a path beginning `images/`) from beating
 * the real file, and it is why this lives on the server and not in the browser.
 *
 * Returns null when nothing matches — which is a 404, which is the next root.
 */
function resolveInRoot(root: string, relSegments: string[]): string | null {
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (rootNorm === '') return null
  const rootSegments = rootNorm.split('/').filter(s => s !== '')
  const rootAbs = resolve(rootNorm)
  // The filename itself can never be overlapped away, so at most n-1 segments.
  const maxOverlap = Math.min(rootSegments.length, relSegments.length - 1)

  for (let k = maxOverlap; k >= 0; k--) {
    if (k > 0) {
      const tail = rootSegments.slice(rootSegments.length - k)
      // Case-insensitive: the same folder spelled two ways is the same folder on
      // the machine this actually runs on.
      const matches = tail.every((seg, i) => seg.toLowerCase() === relSegments[i].toLowerCase())
      if (!matches) continue
    }
    const candidate = resolve(rootAbs, ...relSegments.slice(k))
    // Never leave the configured folder, whatever the path claimed.
    if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) continue
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not there under this overlap — try a shorter one
    }
  }
  return null
}

/** A short, plain-text refusal. The card in the app is what a person reads; this
 *  is what they see if they open the URL directly. */
function refuse(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(message)
}

/**
 * Serve one file, honouring a single `Range`. `<audio controls>` asks for ranges
 * to scrub, and a server that ignores them gives a clip that plays once and
 * cannot be seeked.
 */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, size: number): void {
  res.setHeader('Content-Type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
  res.setHeader('Accept-Ranges', 'bytes')
  // Read-only local files, and a person may replace one on disk at any time.
  res.setHeader('Cache-Control', 'no-cache')

  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range && size > 0) {
    const hasStart = range[1] !== ''
    let start = hasStart ? Number(range[1]) : 0
    let end = range[2] !== '' ? Number(range[2]) : size - 1
    if (!hasStart) {
      // `bytes=-N` means the LAST N bytes.
      start = Math.max(0, size - Number(range[2] === '' ? 0 : range[2]))
      end = size - 1
    }
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
      end = Math.min(end, size - 1)
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(file, { start, end }).pipe(res)
      return
    }
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${size}`)
    res.end()
    return
  }

  res.statusCode = 200
  res.setHeader('Content-Length', String(size))
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(file).pipe(res)
}

/**
 * The middleware. Mounted at `/__media`, so `req.url` arrives as `/<i>/<the
 * media[].path exactly as the graph file wrote it>`.
 *
 * Every failure is a status code and a sentence. The app turns a 404 into "try
 * the next configured root", and when every root has 404'd the card names all of
 * them. A missing folder is a message, never a crash.
 */
function mediaMiddleware(projectRoot: string) {
  return function daggerMedia(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return }

    const raw = (req.url ?? '').split('?')[0].split('#')[0]
    const match = /^\/(\d+)\/(.+)$/.exec(raw)
    if (!match) { refuse(res, 404, 'media: expected /__media/<root index>/<path>'); return }

    const index = Number(match[1])
    let rel: string
    try {
      rel = decodeURIComponent(match[2])
    } catch {
      refuse(res, 400, 'media: the path is not valid percent-encoding'); return
    }

    const segments = rel.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.')
    if (segments.length === 0 || segments.some(s => s === '..')) {
      refuse(res, 400, 'media: that path is not addressable'); return
    }

    const roots = readMediaRoots(projectRoot)
    const root = index < roots.length ? roots[index] : ''
    if (root === '') {
      refuse(res, 404, `media: no folder is configured at position ${index} of ${MEDIA_ROOTS_FILE}`); return
    }
    if (!isAbsolute(root.replace(/\\/g, '/')) && !/^[A-Za-z]:/.test(root)) {
      // A relative entry would silently mean "wherever the server happens to be
      // running", which is not something a person can reason about.
      refuse(res, 404, `media: the folder at position ${index} of ${MEDIA_ROOTS_FILE} is not an absolute path`); return
    }

    const file = resolveInRoot(root, segments)
    if (file === null) {
      refuse(res, 404, `media: not found under the folder configured at position ${index} of ${MEDIA_ROOTS_FILE}`); return
    }

    try {
      sendFile(req, res, file, statSync(file).size)
    } catch {
      refuse(res, 404, 'media: the file could not be read')
    }
  }
}

/** Mounts every configured folder on the dev server and on `vite preview`. The
 *  built bundle served by anything else has no such mounts — see the note in
 *  `src/lib/mediaConfig.ts`. */
function daggerMediaRoots(): Plugin {
  let projectRoot = process.cwd()
  return {
    name: 'dagger-media-roots',
    configResolved(config) { projectRoot = config.root },
    configureServer(server) { server.middlewares.use(MEDIA_MOUNT, mediaMiddleware(projectRoot)) },
    configurePreviewServer(server) { server.middlewares.use(MEDIA_MOUNT, mediaMiddleware(projectRoot)) },
  }
}

// https://vite.dev/config/
//
// Dev (`npm run dev`): base stays '/' so the app is at http://localhost:5173/.
// Build (`npm run build`): base becomes the GitHub Pages subpath.
// Defaults to '/DAGGER_Visualizer/' (matches this repo name); override via
// BASE_PATH env var for forks, e.g. `BASE_PATH=/my-fork/ npm run build`.
export default defineConfig(({ command }) => ({
  plugins: [react(), daggerMediaRoots()],
  base: command === 'build' ? (process.env.BASE_PATH ?? '/DAGGER_Visualizer/') : '/',
}))
