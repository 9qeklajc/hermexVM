import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const port = Number(env.VITE_DEV_PORT ?? "5176");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("VITE_DEV_PORT must be an integer between 1 and 65535");
  }

  return {
    envDir: repoRoot,
    plugins: [react()],
    define: {
      // Some transitive deps reference process.env; keep them happy in the browser.
      "process.env": {},
    },
    build: {
      target: "es2022",
    },
    server: {
      host: env.VITE_DEV_HOST ?? "0.0.0.0",
      port,
    },
  };
});
