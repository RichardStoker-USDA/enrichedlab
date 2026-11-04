import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [svelte()],
	base: "/",
	build: { outDir: "dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
	server: {
		port: 5197,
		proxy: process.env.LAB_ENGINE ? { "/rpc": { target: process.env.LAB_ENGINE, ws: true }, "/canvas": process.env.LAB_ENGINE, "/pair": process.env.LAB_ENGINE } : undefined,
	},
});
