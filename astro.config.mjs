import { defineConfig } from "astro/config";

import tailwindcss from "@tailwindcss/vite";

import mdx from "@astrojs/mdx";

// https://astro.build/config
export default defineConfig({
  site: 'https://pedrobritto.com',
  
  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [mdx()],
});