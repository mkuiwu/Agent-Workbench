import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  root: "webapp",
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.WEB_PORT ?? "3000"}`,
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: false,
  },
});
