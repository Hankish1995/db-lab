import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { contentPlugin } from './vite/content-plugin';

export default defineConfig({
  plugins: [react(), tailwindcss(), contentPlugin({ contentDir: path.resolve(import.meta.dirname, 'content') })],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: { port: 5173 },
});
