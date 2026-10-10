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
        // internal: the bridge of Orbit's internal pages (DT-13), run in every page of a profile.
        input: { shell: resolve('src/preload/shell.ts'), internal: resolve('src/preload/internal.ts') },
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
