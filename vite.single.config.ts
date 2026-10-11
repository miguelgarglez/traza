import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// One double-clickable HTML file: every asset inlined, fonts included.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: {
    outDir: 'dist-single',
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
  },
})
