import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for the builder SPA. Alchemy's `Cloudflare.Vite` resource
 * merges its own Cloudflare integration on top of this config — do NOT
 * add `@cloudflare/vite-plugin` here.
 */
export default defineConfig({
  plugins: [react()],
});
