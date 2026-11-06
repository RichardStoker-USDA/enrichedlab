<script lang="ts">
	import { lab } from "../../lib/store.svelte.ts";
	import { rpc } from "../../lib/rpc.ts";
	import { type Column, formatCell, matcher, readTable, stats, type Table, toCsv } from "../../lib/data.ts";

	let { id }: { id: string } = $props();
	const view = $derived(lab.canvases.find((c) => c.id === id));

	let table = $state.raw<Table | undefined>();
	let error = $state("");
	let loading = $state(true);
	$effect(() => {
		if (!view) return;
		void view.version;
		let current = true;
		loading = true;
		error = "";
		void rpc
			.call("view.data", { canvasId: id })
			.then(readTable)
			.then((t) => current && (table = t))
			.catch((e: Error) => current && (error = e.message))
			.finally(() => current && (loading = false));
		return () => (current = false);
	});

	const ROW = 26;
	let filters = $state<Record<number, string>>({});
	let search = $state("");
	let sort = $state<{ col: number; dir: 1 | -1 } | undefined>();
	let widths = $state<number[]>([]);
	let selected = $state<{ row: number; col: number } | undefined>();
	let focusCol = $state<number | undefined>();

	$effect(() => {
		if (!table) return;
		// Widths from the header and a sample of values, within readable bounds.
		widths = table.columns.map((c) => {
			let longest = c.name.length + 3;
			for (let r = 0; r < Math.min(table!.rows, 200); r++) longest = Math.max(longest, formatCell(c.values[r] ?? null).length);
			return Math.min(320, Math.max(72, longest * 7.4 + 24));
		});
		filters = {};
		sort = undefined;
		selected = undefined;
	});

	let debounced = $state({ filters: {} as Record<number, string>, search: "" });
	$effect(() => {
		const next = { filters: { ...filters }, search };
		const timer = setTimeout(() => (debounced = next), 120);
		return () => clearTimeout(timer);
	});

	const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
	/** Row numbers that pass the filters, in sorted order. */
	const order = $derived.by(() => {
		if (!table) return [] as number[];
		const t = table;
		const tests = Object.entries(debounced.filters)
			.map(([c, q]) => ({ col: t.columns[Number(c)]!, test: matcher(t.columns[Number(c)]!, q) }))
			.filter((f) => f.test);
		const needle = debounced.search.trim().toLowerCase();
		const rows: number[] = [];
		for (let r = 0; r < t.rows; r++) {
			if (!tests.every((f) => f.test!(f.col.values[r] ?? null))) continue;
			if (needle && !t.columns.some((c) => c.values[r] !== null && String(c.values[r]).toLowerCase().includes(needle))) continue;
			rows.push(r);
		}
		if (sort) {
			const { col, dir } = sort;
			const values = t.columns[col]!.values;
			const numeric = t.columns[col]!.type === "number";
			rows.sort((a, b) => {
				const x = values[a] ?? null;
				const y = values[b] ?? null;
				if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
				return dir * (numeric ? (x as number) - (y as number) : collator.compare(String(x), String(y)));
			});
		}
		return rows;
	});

	function toggleSort(col: number) {
		sort = sort?.col !== col ? { col, dir: 1 } : sort.dir === 1 ? { col, dir: -1 } : undefined;
	}

	let scroller: HTMLDivElement | undefined = $state();
	let scrollTop = $state(0);
	let height = $state(400);
	const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 8));
	const last = $derived(Math.min(order.length, Math.ceil((scrollTop + height) / ROW) + 8));
	const visible = $derived(order.slice(first, last));

	function resizeCol(e: PointerEvent, c: number) {
		e.stopPropagation();
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		const start = e.clientX;
		const base = widths[c]!;
		const move = (ev: PointerEvent) => (widths[c] = Math.max(48, base + ev.clientX - start));
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", () => handle.removeEventListener("pointermove", move), { once: true });
	}

	function copySelected(e: KeyboardEvent) {
		if (!table || !selected || !((e.metaKey || e.ctrlKey) && e.key === "c")) return;
		e.preventDefault();
		void navigator.clipboard.writeText(formatCell(table.columns[selected.col]!.values[selected.row] ?? null));
		lab.say("Copied the cell.");
	}

	function exportCsv() {
		if (!table || !view) return;
		const blob = new Blob([toCsv(table, order)], { type: "text/csv" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${view.title.replace(/\.[^.]+$/, "")}${order.length < table.rows ? "-filtered" : ""}.csv`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	let plotOpen = $state(false);
	let plotX = $state(0);
	let plotY = $state(1);
	let plotColor = $state(-1);
	async function makePlot() {
		if (!table || !view?.source || !lab.current) return;
		plotOpen = false;
		const name = (i: number) => table!.columns[i]!.name;
		try {
			const made = await rpc.call("view.open", { sessionId: lab.current, path: view.source.path, plot: { x: name(plotX), y: name(plotY), ...(plotColor >= 0 ? { color: name(plotColor) } : {}) } });
			lab.showView(made.id);
		} catch (e) {
			lab.say((e as Error).message);
		}
	}

	const numericCols = $derived(table ? table.columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === "number") : []);
	const focusStats = $derived(table && focusCol !== undefined ? { col: table.columns[focusCol]!, s: stats(table.columns[focusCol]!) } : undefined);
	const typeMark = (c: Column) => (c.type === "number" ? "#" : c.type === "boolean" ? "✓" : "Aa");
	const totalWidth = $derived(widths.reduce((a, b) => a + b, 56));
</script>

<div class="table-pane">
	<div class="tools">
		<input class="field search" placeholder="Search all columns" bind:value={search} aria-label="Search all columns" />
		<span class="count">
			{#if table}
				{order.length.toLocaleString()}{order.length < table.rows ? ` of ${table.rows.toLocaleString()}` : ""} rows · {table.columns.length} columns
			{/if}
		</span>
		<div class="plot-menu">
			<button class="btn" onclick={() => (plotOpen = !plotOpen)} disabled={numericCols.length < 1} aria-expanded={plotOpen}>Plot</button>
			{#if plotOpen && table}
				<div class="menu plot-form">
					<label>Horizontal <select class="field" bind:value={plotX}>{#each table.columns as c, i}<option value={i}>{c.name}</option>{/each}</select></label>
					<label>Vertical <select class="field" bind:value={plotY}>{#each table.columns as c, i}<option value={i}>{c.name}</option>{/each}</select></label>
					<label>Color by <select class="field" bind:value={plotColor}><option value={-1}>Nothing</option>{#each table.columns as c, i}<option value={i}>{c.name}</option>{/each}</select></label>
					<p class="scope">Plots every row of the table{order.length < (table?.rows ?? order.length) ? ", not only the filtered ones" : ""}.</p>
					<button class="btn primary" onclick={makePlot}>Draw</button>
				</div>
			{/if}
		</div>
		<button class="btn" onclick={exportCsv} disabled={!table} title="Exports the rows shown, in their current order and filters">Export CSV</button>
	</div>

	{#if loading && !table}
		<p class="state">Reading {view?.title ?? "the data"}…</p>
	{:else if error}
		<p class="state bad">{error}</p>
	{:else if table}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="grid" bind:this={scroller} bind:clientHeight={height} onscroll={() => (scrollTop = scroller?.scrollTop ?? 0)} tabindex="0" role="grid" aria-rowcount={order.length} aria-colcount={table.columns.length} onkeydown={copySelected}>
			<div class="head" style:width={`${totalWidth}px`} role="row">
				<div class="rownum" role="columnheader"></div>
				{#each table.columns as col, c (c)}
					<div class="th" style:width={`${widths[c]}px`} role="columnheader" aria-sort={sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"} class:num={col.type === "number"}>
						<button class="th-name" onclick={() => toggleSort(c)} onfocus={() => (focusCol = c)} onmouseenter={() => (focusCol = c)} title={`Sort by ${col.name}`}>
							<span class="type">{typeMark(col)}</span>
							<span class="label">{col.name}</span>
							{#if sort?.col === c}<span class="arrow">{sort.dir === 1 ? "↑" : "↓"}</span>{/if}
						</button>
						<input class="filter" placeholder={col.type === "number" ? "> 0" : "filter"} bind:value={filters[c]} aria-label={`Filter ${col.name}`} />
						<span class="resize" role="separator" aria-orientation="vertical" onpointerdown={(e) => resizeCol(e, c)}></span>
					</div>
				{/each}
			</div>
			<div class="rows" style:height={`${order.length * ROW}px`} style:width={`${totalWidth}px`}>
				<div style:transform={`translateY(${first * ROW}px)`}>
					{#each visible as r (r)}
						<div class="tr" role="row">
							<div class="rownum">{r + 1}</div>
							{#each table.columns as col, c (c)}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<div class="td" class:num={col.type === "number"} class:null={col.values[r] === null} class:sel={selected?.row === r && selected.col === c} style:width={`${widths[c]}px`} role="gridcell" tabindex="-1" onclick={() => (selected = { row: r, col: c })}>
									{col.values[r] === null ? "—" : formatCell(col.values[r] ?? null)}
								</div>
							{/each}
						</div>
					{/each}
				</div>
			</div>
		</div>
		<div class="foot">
			{#if focusStats}
				<strong>{focusStats.col.name}</strong>
				<span class="scope-note">all rows</span>
				<span>{focusStats.col.type}</span>
				<span>{focusStats.s.present.toLocaleString()} present</span>
				{#if focusStats.s.missing}<span>{focusStats.s.missing.toLocaleString()} missing</span>{/if}
				<span>{focusStats.s.distinct.toLocaleString()} distinct</span>
				{#if focusStats.s.mean !== undefined}
					<span>min {formatCell(focusStats.s.min!)}</span>
					<span>mean {formatCell(focusStats.s.mean)}</span>
					<span>max {formatCell(focusStats.s.max!)}</span>
				{/if}
			{:else}
				<span>Point at a column for its statistics. Click a header to sort; type in a filter (text, or &gt; &lt; = with numbers).</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.scope {
		margin: 0;
		font-size: 11.5px;
		color: var(--text-muted);
	}
	.scope-note {
		color: var(--text-muted);
	}
	.table-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		font-size: 12.5px;
	}
	.tools {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-bottom: 1px solid var(--rule);
	}
	.search {
		width: 200px;
		height: 28px;
		font-size: 12.5px;
	}
	.count {
		flex: 1;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.tools .btn {
		height: 28px;
		font-size: 12.5px;
	}
	.plot-menu {
		position: relative;
	}
	.plot-form {
		right: 0;
		top: calc(100% + 6px);
		display: grid;
		gap: 8px;
		padding: 12px;
		width: 260px;
	}
	.plot-form label {
		display: grid;
		gap: 4px;
		font-size: 12px;
		color: var(--text-muted);
	}
	.state {
		margin: auto;
		color: var(--text-faint);
	}
	.state.bad {
		color: var(--bad);
		max-width: 48ch;
		text-align: center;
	}
	.grid {
		flex: 1;
		min-height: 0;
		overflow: auto;
		outline: none;
		font-family: var(--font-mono);
	}
	.head {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		background: var(--surface);
		border-bottom: 1px solid var(--rule-strong);
	}
	.th {
		position: relative;
		flex: none;
		padding: 4px 8px 6px;
		border-right: 1px solid var(--rule);
		font-family: var(--font-ui);
	}
	.th-name {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		height: 22px;
		font-weight: 600;
		text-align: left;
	}
	.th.num .th-name {
		justify-content: flex-end;
	}
	.type {
		font: 10px var(--font-mono);
		color: var(--text-faint);
	}
	.label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.arrow {
		color: var(--accent-text);
	}
	.filter {
		width: 100%;
		height: 22px;
		margin-top: 2px;
		padding: 0 6px;
		border: 1px solid transparent;
		border-radius: 4px;
		background: var(--hover);
		font: 11.5px var(--font-mono);
		outline: none;
	}
	.filter:focus {
		border-color: var(--accent);
		background: var(--canvas);
	}
	.resize {
		position: absolute;
		top: 0;
		right: -4px;
		width: 8px;
		height: 100%;
		cursor: col-resize;
		touch-action: none;
		z-index: 1;
	}
	.rownum {
		flex: none;
		width: 56px;
		padding: 0 8px;
		text-align: right;
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	.head .rownum {
		border-right: 1px solid var(--rule);
	}
	.tr {
		display: flex;
		height: 26px;
		align-items: center;
		border-bottom: 1px solid color-mix(in srgb, var(--rule) 60%, transparent);
	}
	.tr:hover {
		background: var(--hover);
	}
	.td {
		flex: none;
		height: 100%;
		padding: 0 8px;
		line-height: 26px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.td.null {
		color: var(--text-faint);
	}
	.td.sel {
		box-shadow: inset 0 0 0 1.5px var(--accent);
	}
	.foot {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		padding: 7px 12px;
		border-top: 1px solid var(--rule);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.foot strong {
		color: var(--text);
	}
</style>
