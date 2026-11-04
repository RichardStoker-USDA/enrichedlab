<script lang="ts">
	import { onThemeChange, tokenColor } from "../../lib/theme.ts";
	import { onDestroy } from "svelte";
	import { lab } from "../../lib/store.svelte.ts";
	import { rpc } from "../../lib/rpc.ts";
	import { formatCell, readTable, type Table } from "../../lib/data.ts";
	import { CATEGORY, createRenderer, hex, NearestIndex, ramp, type Renderer, ticks, type View } from "../../lib/plot.ts";

	let { id, active }: { id: string; active: boolean } = $props();
	const view = $derived(lab.canvases.find((c) => c.id === id));

	let canvas: HTMLCanvasElement | undefined = $state();
	let overlay: HTMLCanvasElement | undefined = $state();
	let box: HTMLDivElement | undefined = $state();
	let renderer: Renderer | undefined;
	let table = $state.raw<Table | undefined>();
	let error = $state("");
	let loading = $state(true);
	let backend = $state("");
	let legend = $state<{ label: string; color: string }[]>([]);
	let hover = $state<{ x: number; y: number; text: string } | undefined>();
	let range: View = { x0: 0, x1: 1, y0: 0, y1: 1 };
	let home: View = range;
	let xs = new Float32Array();
	let ys = new Float32Array();
	let rows = $state.raw<number[]>([]);
	let index: NearestIndex | undefined;
	const pad = { left: 56, right: 16, top: 14, bottom: 36 };

	$effect(() => {
		if (!view?.plot || !canvas) return;
		void view.version;
		let current = true;
		error = "";
		loading = true;
		void (async () => {
			try {
				const t = await readTable(await rpc.call("view.data", { canvasId: id }));
				if (!current) return;
				table = t;
				renderer ??= await createRenderer(canvas!);
				backend = renderer.backend;
				build(t);
				layout();
			} catch (e) {
				if (current) error = (e as Error).message;
			} finally {
				if (current) loading = false;
			}
		})();
		return () => (current = false);
	});

	function build(t: Table) {
		const spec = view!.plot!;
		const col = (name: string) => t.columns.find((c) => c.name === name);
		const cx = col(spec.x);
		const cy = col(spec.y);
		if (!cx || !cy) throw new Error(`The data has no column ${!cx ? spec.x : spec.y}.`);
		const cc = spec.color ? col(spec.color) : undefined;
		const kept: number[] = [];
		for (let r = 0; r < t.rows; r++) if (typeof cx.values[r] === "number" && typeof cy.values[r] === "number") kept.push(r);
		if (spec.type === "line") kept.sort((a, b) => (cx.values[a] as number) - (cx.values[b] as number));
		rows = kept;
		xs = Float32Array.from(rows, (r) => cx.values[r] as number);
		ys = Float32Array.from(rows, (r) => cy.values[r] as number);
		const color = new Float32Array(rows.length * 4);
		const alpha = rows.length > 200_000 ? 0.45 : rows.length > 20_000 ? 0.7 : 0.9;
		const accent = hex(CATEGORY[0]!);
		legend = [];
		if (cc?.type === "number") {
			let lo = Infinity;
			let hi = -Infinity;
			for (const r of rows) {
				const v = cc.values[r];
				if (typeof v === "number") (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
			}
			rows.forEach((r, i) => {
				const v = cc.values[r];
				const [R, G, B] = typeof v === "number" ? ramp((v - lo) / (hi - lo || 1)) : [0.5, 0.5, 0.5];
				color.set([R, G, B, alpha], i * 4);
			});
			legend = [{ label: `${cc.name} ${formatCell(lo)}`, color: "#440154" }, { label: formatCell(hi), color: "#fde725" }];
		} else if (cc) {
			const cats = new Map<string, number>();
			rows.forEach((r, i) => {
				const key = String(cc.values[r] ?? "missing");
				if (!cats.has(key)) cats.set(key, cats.size);
				const [R, G, B] = hex(CATEGORY[cats.get(key)! % CATEGORY.length]!);
				color.set([R, G, B, alpha], i * 4);
			});
			legend = [...cats.keys()].slice(0, 10).map((label, i) => ({ label, color: CATEGORY[i % CATEGORY.length]! }));
		} else {
			for (let i = 0; i < rows.length; i++) color.set([...accent, alpha], i * 4);
		}
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
		for (let i = 0; i < xs.length; i++) {
			x0 = Math.min(x0, xs[i]!), x1 = Math.max(x1, xs[i]!), y0 = Math.min(y0, ys[i]!), y1 = Math.max(y1, ys[i]!);
		}
		const mx = (x1 - x0 || 1) * 0.04;
		const my = (y1 - y0 || 1) * 0.06;
		home = range = { x0: x0 - mx, x1: x1 + mx, y0: y0 - my, y1: y1 + my };
		index = new NearestIndex(xs, ys, home);
		renderer!.setData({ x: xs, y: ys, color, line: spec.type === "line" });
	}

	function layout() {
		if (!box || !canvas || !overlay || !renderer) return;
		const dpr = devicePixelRatio || 1;
		const w = box.clientWidth - pad.left - pad.right;
		const h = box.clientHeight - pad.top - pad.bottom;
		renderer.resize(Math.max(1, w), Math.max(1, h), dpr);
		canvas.style.width = `${Math.max(1, w)}px`;
		canvas.style.height = `${Math.max(1, h)}px`;
		overlay.width = box.clientWidth * dpr;
		overlay.height = box.clientHeight * dpr;
		draw();
	}

	let frame = 0;
	function draw() {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			if (!renderer || !overlay || !box) return;
			renderer.draw(range, rows.length > 100_000 ? 2 : rows.length > 10_000 ? 3 : 4.5);
			axes();
		});
	}

	function axes() {
		const ctx = overlay!.getContext("2d")!;
		const dpr = devicePixelRatio || 1;
		const W = box!.clientWidth;
		const H = box!.clientHeight;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		const style = getComputedStyle(box!);
		const faint = tokenColor("--text-faint", box!);
		const rule = tokenColor("--rule", box!);
		ctx.font = `11px ${style.getPropertyValue("--font-ui")}`;
		ctx.fillStyle = faint;
		ctx.strokeStyle = rule;
		ctx.lineWidth = 1;
		const w = W - pad.left - pad.right;
		const h = H - pad.top - pad.bottom;
		const px = (v: number) => pad.left + ((v - range.x0) / (range.x1 - range.x0)) * w;
		const py = (v: number) => pad.top + h - ((v - range.y0) / (range.y1 - range.y0)) * h;
		ctx.textAlign = "center";
		for (const t of ticks(range.x0, range.x1)) {
			ctx.beginPath();
			ctx.moveTo(Math.round(px(t)) + 0.5, pad.top);
			ctx.lineTo(Math.round(px(t)) + 0.5, pad.top + h);
			ctx.stroke();
			ctx.fillText(formatCell(t), px(t), pad.top + h + 16);
		}
		ctx.textAlign = "right";
		for (const t of ticks(range.y0, range.y1, 5)) {
			ctx.beginPath();
			ctx.moveTo(pad.left, Math.round(py(t)) + 0.5);
			ctx.lineTo(pad.left + w, Math.round(py(t)) + 0.5);
			ctx.stroke();
			ctx.fillText(formatCell(t), pad.left - 8, py(t) + 4);
		}
		ctx.textAlign = "center";
		ctx.fillText(view?.plot?.x ?? "", pad.left + w / 2, H - 6);
		ctx.save();
		ctx.translate(12, pad.top + h / 2);
		ctx.rotate(-Math.PI / 2);
		ctx.fillText(view?.plot?.y ?? "", 0, 0);
		ctx.restore();
	}

	function toData(e: { clientX: number; clientY: number }) {
		const r = canvas!.getBoundingClientRect();
		return { x: range.x0 + ((e.clientX - r.left) / r.width) * (range.x1 - range.x0), y: range.y1 - ((e.clientY - r.top) / r.height) * (range.y1 - range.y0), r };
	}

	function wheel(e: WheelEvent) {
		e.preventDefault();
		const { x, y } = toData(e);
		const k = Math.exp(e.deltaY * 0.0015);
		range = { x0: x + (range.x0 - x) * k, x1: x + (range.x1 - x) * k, y0: y + (range.y0 - y) * k, y1: y + (range.y1 - y) * k };
		draw();
	}

	function pan(e: PointerEvent) {
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);
		const start = { x: e.clientX, y: e.clientY, view: range };
		const r = canvas!.getBoundingClientRect();
		const move = (ev: PointerEvent) => {
			const dx = ((ev.clientX - start.x) / r.width) * (start.view.x1 - start.view.x0);
			const dy = ((ev.clientY - start.y) / r.height) * (start.view.y1 - start.view.y0);
			range = { x0: start.view.x0 - dx, x1: start.view.x1 - dx, y0: start.view.y0 + dy, y1: start.view.y1 + dy };
			draw();
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", () => target.removeEventListener("pointermove", move), { once: true });
	}

	function point(e: PointerEvent) {
		if (!index || e.buttons) return;
		const { x, y, r } = toData(e);
		const rx = (8 / r.width) * (range.x1 - range.x0);
		const ry = (8 / r.height) * (range.y1 - range.y0);
		const i = index.find(x, y, rx, ry);
		if (i === undefined || !table) return void (hover = undefined);
		const row = rows[i]!;
		const spec = view!.plot!;
		const parts = [`${spec.x} ${formatCell(xs[i]!)}`, `${spec.y} ${formatCell(ys[i]!)}`];
		if (spec.color) parts.push(`${spec.color} ${formatCell(table.columns.find((c) => c.name === spec.color)?.values[row] ?? null)}`);
		hover = { x: e.clientX - r.left + pad.left + 12, y: e.clientY - r.top + pad.top - 8, text: `row ${row + 1} · ${parts.join(" · ")}` };
	}

	$effect(() => {
		if (!box) return;
		const observer = new ResizeObserver(() => layout());
		observer.observe(box);
		return () => observer.disconnect();
	});
	$effect(() => {
		if (active) layout();
	});
	// Axis text and grid follow light and dark mode.
	$effect(() => onThemeChange(() => draw()));
	onDestroy(() => renderer?.destroy());
</script>

<div class="plot-pane">
	<div class="tools">
		<span class="title">{view?.plot ? `${view.plot.y} against ${view.plot.x}` : (view?.title ?? "")}</span>
		<span class="meta">{rows.length ? `${rows.length.toLocaleString()} points` : ""}{backend ? ` · ${backend}` : ""}</span>
		<button class="btn" onclick={() => ((range = home), draw())}>Reset view</button>
	</div>
	{#if error}
		<p class="state">{error}</p>
	{/if}
	<div class="stage" bind:this={box}>
		<canvas class="data" bind:this={canvas} style:left={`${pad.left}px`} style:top={`${pad.top}px`}
			onwheel={wheel} onpointerdown={pan} onpointermove={point} onpointerleave={() => (hover = undefined)} ondblclick={() => ((range = home), draw())}></canvas>
		<canvas class="axes" bind:this={overlay}></canvas>
		{#if loading && !error}
			<p class="loading">Loading the data…</p>
		{/if}
		{#if hover}
			<p class="tip" style:left={`${hover.x}px`} style:top={`${hover.y}px`}>{hover.text}</p>
		{/if}
	</div>
	{#if legend.length}
		<div class="legend">
			{#each legend as item}<span><i style:background={item.color}></i>{item.label}</span>{/each}
		</div>
	{/if}
</div>

<style>
	.plot-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px 8px 14px;
		border-bottom: 1px solid var(--rule);
		font-size: 12.5px;
	}
	.title {
		font-weight: 600;
	}
	.meta {
		flex: 1;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.tools .btn {
		height: 28px;
		font-size: 12.5px;
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
	}
	canvas {
		position: absolute;
	}
	.data {
		width: auto;
		height: auto;
		cursor: grab;
		touch-action: none;
	}
	.data:active {
		cursor: grabbing;
	}
	.axes {
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	.tip {
		position: absolute;
		margin: 0;
		padding: 5px 8px;
		border-radius: var(--radius-small);
		border: 1px solid var(--rule);
		background: var(--raised);
		box-shadow: var(--shadow);
		font: 11.5px var(--font-mono);
		pointer-events: none;
		white-space: nowrap;
	}
	.loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--text-faint);
		font-size: 13px;
		pointer-events: none;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		padding: 8px 14px;
		border-top: 1px solid var(--rule);
		font-size: 12px;
		color: var(--text-muted);
	}
	.legend i {
		display: inline-block;
		width: 8px;
		height: 8px;
		margin-right: 6px;
		border-radius: 50%;
	}
	.state {
		margin: 12px;
		color: var(--bad);
		font-size: 13px;
	}
</style>
