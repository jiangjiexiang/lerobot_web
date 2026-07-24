import { createLogger, defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs";

const certPath = process.env.HTTPS_CERT;
const keyPath = process.env.HTTPS_KEY;
// 与 start_robot.sh / start_wifi_robot.sh 共享后端端口，避免代理指向旧的固定端口。
const backendPort = process.env.PORT || "43127";
const https = certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)
  ? { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }
  : undefined;

const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (message, options) => {
  const detail = `${message}\n${options?.error instanceof Error ? options.error.stack || options.error.message : ""}`;
  const closedWebSocket = detail.includes("ws proxy socket error")
    && (detail.includes("socket has been ended by the other party")
      || detail.includes("writeAfterFIN")
      || detail.includes("ERR_STREAM_WRITE_AFTER_END"));
  if (!closedWebSocket) logError(message, options);
};

export default defineConfig({
  customLogger: logger,
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
