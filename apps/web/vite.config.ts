import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "apps/web",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeManifestIcons: false,
      manifest: {
        name: "EdgeEver",
        short_name: "EdgeEver",
        description: "EdgeEver：基于 Cloudflare 全家桶自托管的开源印象笔记。",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f8fafc",
        theme_color: "#f8fafc",
        lang: "zh-CN",
        categories: ["productivity", "utilities"],
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webp,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/mcp\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp/"),
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/mcp": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
              priority: 40,
            },
            {
              name: "vendor-prosemirror",
              test: /node_modules[\\/](prosemirror-|orderedmap|rope-sequence)[\\/]/,
              priority: 38,
            },
            {
              name: "vendor-tiptap-pm",
              test: /node_modules[\\/]@tiptap[\\/]pm[\\/]/,
              priority: 36,
            },
            {
              name: "vendor-tiptap-core",
              test: /node_modules[\\/]@tiptap[\\/]core[\\/]/,
              priority: 34,
            },
            {
              name: "vendor-tiptap-react",
              test: /node_modules[\\/]@tiptap[\\/]react[\\/]/,
              priority: 32,
            },
            {
              name: "vendor-tiptap-extensions",
              test: /node_modules[\\/]@tiptap[\\/](extension-|extensions)[\\/]/,
              priority: 30,
            },
            {
              name: "vendor-tiptap-starter",
              test: /node_modules[\\/]@tiptap[\\/]starter-kit[\\/]/,
              priority: 29,
            },
            {
              name: "vendor-linkify",
              test: /node_modules[\\/]linkifyjs[\\/]/,
              priority: 29,
            },
            {
              name: "vendor-floating",
              test: /node_modules[\\/](@floating-ui|tippy\.js)[\\/]/,
              priority: 28,
            },
            {
              name: "vendor-query",
              test: /node_modules[\\/]@tanstack[\\/]react-query[\\/]/,
              priority: 25,
            },
            {
              name: "vendor-storage",
              test: /node_modules[\\/](dexie|workbox-window)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor-icons",
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 18,
            },
            {
              name: "vendor-radix",
              test: /node_modules[\\/](@radix-ui|cmdk|vaul)[\\/]/,
              priority: 15,
            },
            {
              name: "vendor-ui-utils",
              test: /node_modules[\\/](class-variance-authority|clsx|tailwind-merge)[\\/]/,
              priority: 12,
            },
            {
              name: "ui-primitives",
              test: /src[\\/]components[\\/]ui[\\/]/,
              priority: 10,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
              priority: 5,
            },
          ],
        },
      },
    },
  },
});
