import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs";

const certPath = process.env.HTTPS_CERT;
const keyPath = process.env.HTTPS_KEY;
// 与 start_robot.sh / start_wifi_robot.sh 共享后端端口，避免代理指向旧的固定端口。
const backendPort = process.env.PORT || "4000";
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
      "/api": `http://localhost:${backendPort}`,
      "/video": `http://localhost:${backendPort}`,
      "/ws": {
        target: `ws://localhost:${backendPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
