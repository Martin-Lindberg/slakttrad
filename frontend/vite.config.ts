import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the site from a sub-path (/<repo>/).
// Using base:"./" keeps assets working without knowing the repo name in advance.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
