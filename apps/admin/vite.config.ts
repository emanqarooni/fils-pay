import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174, // LOCK ADMIN TO 5174
    strictPort: true,
    proxy: {
      '/v1': { target: 'http://localhost:3000', changeOrigin: true, secure: false }
    }
  }
})