import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// Plugin: copy examples/ into dist/ during build so the server can serve them.
function copyExamplesPlugin() {
  return {
    name: "copy-examples",
    closeBundle() {
      const examplesSrc = path.resolve(__dirname, "examples");
      const distDir = path.resolve(__dirname, "dist");
      if (!fs.existsSync(examplesSrc)) return;
      const copy = (src: string, dest: string) => {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dest, { recursive: true });
          for (const entry of fs.readdirSync(src)) {
            copy(path.join(src, entry), path.join(dest, entry));
          }
        } else if (!src.endsWith(":Zone.Identifier")) {
          fs.copyFileSync(src, dest);
        }
      };
      copy(examplesSrc, path.join(distDir, "examples"));
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: "/",
  plugins: [react(), copyExamplesPlugin()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/gen": "http://localhost:8787",
      "/firefox": "http://localhost:8787",
      "/docker": "http://localhost:8787",
      "/logo.svg": "http://localhost:8787",
    },
  },
});
