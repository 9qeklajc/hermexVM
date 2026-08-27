import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Some transitive deps reference process.env; keep them happy in the browser.
    "process.env": {},
  },
  build: {
    target: "es2022",
  },
  server: {
    host: "0.0.0.0",
    port: 5176,
  },
});
