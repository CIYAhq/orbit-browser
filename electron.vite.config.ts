import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { creditsPage } from './scripts/credits'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  main: {
    // Orbit's version and the day of the build, for About and update checks (UP-03, UP-07).
    define: {
      __ORBIT_VERSION__: JSON.stringify(pkg.version),
      __ORBIT_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    },
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // Sandboxed preloads must be a single CommonJS file with no node_modules imports.
      externalizeDeps: false,
      rollupOptions: {
        // shell: Orbit's own views. page: every web page (src/main/nav/page-bridge.ts registers it).
        // internal: the bridge of Orbit's internal pages (DT-13), run in every page of a profile.
        input: {
          shell: resolve('src/preload/shell.ts'),
          page: resolve('src/preload/page.ts'),
          internal: resolve('src/preload/internal.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    // credits.html, the open-source credits About opens (ST-17, UP-07).
    plugins: [react(), creditsPage()],
    build: {
      outDir: 'out/renderer',
      minify: true,
      target: 'chrome140',
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
