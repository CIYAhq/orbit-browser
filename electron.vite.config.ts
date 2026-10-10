import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
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
        input: { shell: resolve('src/preload/shell.ts'), page: resolve('src/preload/page.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      minify: true,
      target: 'chrome140',
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
