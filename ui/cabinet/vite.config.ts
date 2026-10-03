import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const proxyTarget = process.env.VITE_PROXY || "http://127.0.0.1";

export default defineConfig({
  base: "/cabinet/",
  plugins: [react()],
  resolve: {
    alias: {
      "@contract": path.resolve(__dirname, "../../contract/plant.ts"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 9000,
    proxy: {
      "/api": { target: proxyTarget, changeOrigin: true },
      "/auth": { target: proxyTarget, changeOrigin: true },
      "/websocket": { target: proxyTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
