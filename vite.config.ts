import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/docker/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/gen': 'http://localhost:8787',
    },
  },
})
