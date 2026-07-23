import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs";

const certPath = process.env.HTTPS_CERT;
const keyPath = process.env.HTTPS_KEY;
const https = certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)
  ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }
  : undefined;

export default defineConfig({
  plugins: [vue()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    https,
    proxy: {
      "/api": "http://localhost:3001",
      "/video": "http://localhost:3001",
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
