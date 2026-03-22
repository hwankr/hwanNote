import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const host = env.TAURI_DEV_HOST || "127.0.0.1";

  return {
    plugins: [react()],
    clearScreen: false,
    server: {
      host,
      port: 5173,
      strictPort: true,
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    build: {
      target: env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
      minify: !env.TAURI_ENV_DEBUG ? "esbuild" : false,
      sourcemap: !!env.TAURI_ENV_DEBUG,
    },
  };
});
