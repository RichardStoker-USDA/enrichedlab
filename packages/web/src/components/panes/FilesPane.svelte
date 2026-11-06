<script lang="ts">
	import { lab } from "../../lib/store.svelte.ts";
	import { contextMenu, separator, type MenuAction } from "../../lib/menu.svelte.ts";
	import { mac } from "../../lib/places.ts";
	import { rpc } from "../../lib/rpc.ts";
	import { highlight, languageOf } from "../../lib/highlight.ts";

	type Entry = { name: string; type: "file" | "dir" | "link" | "other"; size: number };

	let listings = $state<Record<string, Entry[]>>({});
	let openDirs = $state<Record<string, boolean>>({ ".": true });
	let root = $state("");
	let error = $state("");
	let preview = $state<{ path: string; html?: string; text?: string; note?: string } | undefined>();

	async function load(path: string) {
		if (!lab.current) return;
		try {
			const listed = await rpc.call("fs.list", { sessionId: lab.current, path });
			listings[path] = listed.entries;
			root = listed.root;
			error = "";
		} catch (e) {
			error = (e as Error).message;
		}
	}

	$effect(() => {
		void lab.current;
		void lab.place.id;
		listings = {};
		openDirs = { ".": true };
		preview = undefined;
		void load(".");
	});

	/** A file's or folder's right-click menu. Paths outside this computer can be copied but not shown in Finder. */
	function fileActions(path: string, dir: boolean): MenuAction[] {
		const full = `${root.replace(/[\\/]$/, "")}/${path}`;
		return [
			dir ? { label: openDirs[path] ? "Collapse" : "Expand", run: () => toggle(path) } : { label: "Open", run: () => openFile(path) },
			separator,
			{ label: "Copy Path", run: () => lab.copy(full, "the path") },
			{ label: "Copy Relative Path", run: () => lab.copy(path, "the relative path") },
			...(lab.place.id === "local" && window.labDesktop ? [separator, { label: mac ? "Show in Finder" : "Show in Folder", run: () => lab.reveal(full) }] : []),
		];
	}

	function join(dir: string, name: string) {
		return dir === "." ? name : `${dir}/${name}`;
	}

	async function toggle(path: string) {
		openDirs[path] = !openDirs[path];
		if (openDirs[path] && !listings[path]) await load(path);
	}

	const VIEWABLE = /\.(csv|tsv|tab|json|jsonl|ndjson|parquet|png|jpe?g|gif|webp|svg|html?)$/i;

	async function openFile(path: string) {
		if (VIEWABLE.test(path)) return void lab.openFile(path);
		if (!lab.current) return;
		try {
			const file = await rpc.call("fs.read", { sessionId: lab.current, path });
			if (file.binary || file.text === undefined) return void (preview = { path, note: `${path} is binary or over 2 MB.` });
			const lang = languageOf(path);
			preview = { path, text: file.text };
			if (lang) preview = { path, html: await highlight(file.text, lang) };
		} catch (e) {
			lab.say((e as Error).message);
		}
	}

	const size = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);
</script>

{#snippet tree(dir: string, depth: number)}
	{#each listings[dir] ?? [] as entry (entry.name)}
		{@const path = join(dir, entry.name)}
		{#if entry.type === "dir"}
			<button class="row" style:padding-left={`${12 + depth * 14}px`} onclick={() => toggle(path)} aria-expanded={Boolean(openDirs[path])} use:contextMenu={() => fileActions(path, true)}>
				<span class="caret" class:open={openDirs[path]}></span><span class="name dir">{entry.name}</span>
			</button>
			{#if openDirs[path]}{@render tree(path, depth + 1)}{/if}
		{:else}
			<button class="row" class:viewable={VIEWABLE.test(entry.name)} class:current={preview?.path === path} style:padding-left={`${26 + depth * 14}px`} onclick={() => openFile(path)} use:contextMenu={() => fileActions(path, false)}>
				<span class="name">{entry.name}</span><span class="size">{size(entry.size)}</span>
			</button>
		{/if}
	{/each}
{/snippet}

<div class="files-pane" class:split={preview}>
	<div class="list">
		<div class="where" title={root}>
			<span class="place-dot" class:local={lab.place.id === "local"} style:--dot={`var(${lab.place.color})`}></span>
			{lab.place.title}<span class="root">{root}</span>
			<button class="icon-btn" onclick={() => ((listings = {}), load("."))} aria-label="Refresh" title="Refresh">
				<svg viewBox="0 0 16 16"><path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" /></svg>
			</button>
		</div>
		{#if error}<p class="error">{error}</p>{/if}
		<div class="scroll">{@render tree(".", 0)}</div>
	</div>
	{#if preview}
		<div class="preview">
			<div class="preview-head"><span>{preview.path}</span><button class="icon-btn" onclick={() => (preview = undefined)} aria-label="Close preview"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" /></svg></button></div>
			{#if preview.html}
				<div class="code-view">{@html preview.html}</div>
			{:else if preview.text !== undefined}
				<pre class="code-view">{preview.text}</pre>
			{:else}
				<p class="error">{preview.note}</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.files-pane {
		flex: 1;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		min-width: 0;
		min-height: 0;
		font-size: 13px;
	}
	.files-pane.split {
		grid-template-rows: minmax(120px, 0.45fr) minmax(0, 1fr);
	}
	.list,
	.preview {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.where {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px 4px 12px;
		border-bottom: 1px solid var(--rule);
		font-weight: 500;
		font-size: 12.5px;
	}
	.root {
		flex: 1;
		min-width: 0;
		color: var(--text-faint);
		font: 11.5px var(--font-mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		direction: rtl;
		text-align: left;
	}
	.scroll {
		flex: 1;
		overflow: auto;
		padding: 4px 0;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		height: 26px;
		padding-right: 12px;
		text-align: left;
	}
	.row:hover {
		background: var(--hover);
	}
	.row.current {
		background: var(--selected);
	}
	.name {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.name.dir {
		font-weight: 500;
	}
	.viewable .name {
		color: var(--accent-text);
	}
	.size {
		font: 11px var(--font-mono);
		color: var(--text-faint);
	}
	.caret {
		width: 0;
		height: 0;
		margin: 0 4px;
		border-left: 4px solid var(--text-faint);
		border-top: 3.5px solid transparent;
		border-bottom: 3.5px solid transparent;
		transition: transform 140ms var(--ease-out);
	}
	.caret.open {
		transform: rotate(90deg);
	}
	.preview {
		border-top: 1px solid var(--rule);
	}
	.preview-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 2px 6px 2px 12px;
		font: 11.5px var(--font-mono);
		color: var(--text-muted);
		border-bottom: 1px solid var(--rule);
	}
	.code-view {
		flex: 1;
		margin: 0;
		overflow: auto;
		padding: 10px 14px;
		font: 12px/1.55 var(--font-mono);
	}
	.code-view :global(pre) {
		margin: 0;
		background: transparent !important;
	}
	.error {
		margin: 12px;
		color: var(--text-muted);
	}
</style>
