<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import "@xterm/xterm/css/xterm.css";
	import { lab } from "../../lib/store.svelte.ts";
	import { rpc } from "../../lib/rpc.ts";

	let { active }: { active: boolean } = $props();
	let host: HTMLDivElement | undefined = $state();
	let label = $state("");
	let ended = $state(false);
	let error = $state("");
	let cleanup: (() => void) | undefined;
	// Closed while still starting: whatever opened afterwards is closed at once.
	let gone = false;

	onMount(async () => {
		const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
		const css = getComputedStyle(document.documentElement);
		const v = (name: string) => css.getPropertyValue(name).trim();
		const term = new Terminal({
			fontFamily: v("--font-mono"),
			fontSize: 12.5,
			lineHeight: 1.25,
			cursorBlink: false,
			allowProposedApi: false,
			theme: { background: v("--canvas") || undefined, foreground: v("--text") || undefined, cursor: v("--accent") || undefined, selectionBackground: "rgba(128,128,128,0.3)" },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host!);
		// The GPU renderer where WebGL2 works; xterm's DOM renderer otherwise.
		try {
			const { WebglAddon } = await import("@xterm/addon-webgl");
			const gl = new WebglAddon();
			gl.onContextLoss(() => gl.dispose());
			term.loadAddon(gl);
		} catch {
			// DOM renderer.
		}
		fit.fit();
		let termId: string | undefined;
		try {
			const opened = await rpc.call("term.open", { sessionId: lab.current, cols: term.cols, rows: term.rows });
			termId = opened.termId;
			label = opened.label;
			if (gone) {
				void rpc.call("term.close", { termId }).catch(() => undefined);
				term.dispose();
				return;
			}
		} catch (e) {
			error = (e as Error).message;
			term.dispose();
			return;
		}
		const offOut = rpc.on("term.output", (m) => m.termId === termId && term.write(m.data));
		const offExit = rpc.on("term.exit", (m) => {
			if (m.termId !== termId) return;
			ended = true;
			term.write("\r\n\x1b[2m(ended)\x1b[0m\r\n");
		});
		const input = term.onData((data) => termId && void rpc.call("term.input", { termId, data }));
		const resize = term.onResize(({ cols, rows }) => termId && void rpc.call("term.resize", { termId, cols, rows }));
		const observer = new ResizeObserver(() => fit.fit());
		observer.observe(host!);
		term.focus();
		cleanup = () => {
			observer.disconnect();
			input.dispose();
			resize.dispose();
			offOut();
			offExit();
			if (termId && !ended) void rpc.call("term.close", { termId }).catch(() => undefined);
			term.dispose();
		};
	});

	onDestroy(() => {
		gone = true;
		cleanup?.();
	});
</script>

<div class="terminal-pane" class:active>
	<div class="where">{label}{ended ? " · ended" : ""}</div>
	{#if error}
		<p class="error">{error}</p>
	{/if}
	<div class="host" bind:this={host}></div>
</div>

<style>
	.terminal-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--canvas);
	}
	.where {
		padding: 6px 12px;
		font-size: 11.5px;
		color: var(--text-faint);
		border-bottom: 1px solid var(--rule);
	}
	.where:empty {
		display: none;
	}
	.host {
		flex: 1;
		min-height: 0;
		padding: 8px 4px 4px 12px;
	}
	.error {
		margin: 16px;
		color: var(--text-muted);
		font-size: 13px;
	}
</style>
