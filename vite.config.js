import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In production /api is served by Vercel functions on the same domain.
    proxy: { '/api': 'http://localhost:3001' },
  },
});
