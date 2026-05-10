import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // Explicit target matching tsconfig
  target: 'es2022',
  // Node.js runtime platform
  platform: 'node',
})
