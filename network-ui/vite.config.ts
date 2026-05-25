import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// Dev (`npm run dev`): base stays '/' so the app is at http://localhost:5173/.
// Build (`npm run build`): base becomes the GitHub Pages subpath.
// Defaults to '/DAGGER_Visualizer/' (matches this repo name); override via
// BASE_PATH env var for forks, e.g. `BASE_PATH=/my-fork/ npm run build`.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? (process.env.BASE_PATH ?? '/DAGGER_Visualizer/') : '/',
}))
