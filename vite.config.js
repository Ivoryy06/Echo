import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // For GitHub Pages: set base to /Echo/ when building for Pages
  base: "/Echo/",
  server: {
    proxy: { "/api": "http://localhost:5050" },
  },
});
