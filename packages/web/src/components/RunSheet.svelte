<script lang="ts">
	import { tick } from "svelte";
	import { lab } from "../lib/store.svelte.ts";
	import { renderMarkdown, renderPartial, splitBlocks } from "../lib/markdown.ts";
	import { codeBlocks } from "../lib/highlight.ts";
	import { argPreview, folderName } from "../lib/format.ts";
	import { blocks } from "../lib/turns.ts";
	import Activity from "./Activity.svelte";
	import Approval from "./Approval.svelte";
	import Composer from "./Composer.svelte";
	import { mac } from "../lib/places.ts";
	import { separator, showMenu, type MenuAction } from "../lib/menu.svelte.ts";
	import Step from "./Step.svelte";

	let { onMenu }: { onMenu: () => void } = $props();

	/** Calls in the newest answer that haven't finished: the live end of the activity. */
	const runningCalls = $derived.by(() => {
		if (!lab.busy) return undefined;
		const last = [...lab.events].reverse().find((e) => e.t === "assistant");
		const calls = last?.t === "assistant" ? (last.toolCalls ?? []) : [];
		return { calls: calls.map((c) => ({ id: c.id, name: c.name, target: argPreview(c.args) })), pending: lab.pending };
	});
	const items = $derived(blocks(lab.events, runningCalls));
	const lastActivity = $derived(items.findLast((b) => b.kind === "activity")?.id);
	const orphanApprovals = $derived(lab.pending.filter((p) => !items.some((b) => b.kind === "activity" && b.steps.some((s) => s.kind === "running" && s.id === p.callId))));

	const activityWord: Record<string, string> = { thinking: "Thinking", writing: "Writing", tool: "Working", waiting: "Waiting for you", compacting: "Summarizing older turns", retrying: "Retrying" };
	let startedAt = $state(0);
	let now = $state(Date.now());
	$effect(() => {
		if (lab.busy && !startedAt) startedAt = Date.now();
		if (!lab.busy) startedAt = 0;
	});
	$effect(() => {
		if (!lab.busy) return;
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	let scroller: HTMLDivElement | undefined = $state();
	let pinned = $state(true);
	function onScroll() {
		if (!scroller) return;
		pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
	}
	async function toBottom(smooth = false) {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	}
	$effect(() => {
		void items.length;
		void lab.partial.text.length;
		void lab.partial.reasoning.length;
		void lab.pending.length;
		if (pinned) void toBottom();
	});
	$effect(() => {
		void lab.current;
		pinned = true;
		void toBottom();
	});

	const editingTitle = $derived(Boolean(lab.current) && lab.renaming === lab.current);
	let titleDraft = $state("");
	function startRename() {
		titleDraft = lab.summary?.title ?? "";
		lab.renaming = lab.current;
	}
	$effect(() => {
		if (editingTitle) titleDraft = lab.summary?.title ?? "";
	});
	async function finishRename(keep = true) {
		if (!editingTitle) return;
		lab.renaming = undefined;
		if (keep && titleDraft.trim() && titleDraft !== lab.summary?.title) await lab.rename(titleDraft);
	}
	const desktop = typeof window !== "undefined" && Boolean(window.labDesktop);
	function sessionMenu(): MenuAction[] {
		const s = lab.summary;
		if (!s) return [];
		return [
			{ label: "Rename", run: startRename },
			{ label: lab.workbench ? "Hide Workbench" : "Show Workbench", run: () => lab.toggleWorkbench() },
			{ label: "Open Terminal", run: () => lab.openPane("terminal") },
			separator,
			{ label: "Summarize Older Turns", disabled: lab.busy, run: () => lab.compact() },
			...(desktop ? [{ label: mac ? "Show in Finder" : "Show in Folder", run: () => lab.reveal(s.cwd) }] : []),
			{ label: "Copy Folder Path", run: () => lab.copy(s.cwd, "the folder path") },
			separator,
			{ label: "Delete…", disabled: lab.busy, run: () => lab.deleteSession(s.id) },
		];
	}

	const thinkingTail = $derived(lab.partial.reasoning.trimEnd().split("\n").slice(-3).join("\n"));
	/** The answer being written: finished blocks render once, only the tail re-renders as tokens arrive. */
	const streaming = $derived(splitBlocks(lab.partial.text));
	const undoable = $derived(lab.status?.undoable ?? []);
	const project = $derived(lab.summary ? folderName(lab.summary.cwd.replace(/[\\/]\.git[\\/]enrichedlab-worktrees[\\/].*$/, "")) : "");
	const branch = $derived(/enrichedlab-worktrees/.test(lab.summary?.cwd ?? "") ? "own branch" : "");
	let thinkingOpen = $state<Record<string, boolean>>({});
</script>

<header class="head toolbar" style:--marker={`var(${lab.place.color})`} class:moving={lab.moving} class:inset={!lab.sidebar}>
	<button class="icon-btn menu-toggle" onclick={onMenu} aria-label="Show places and sessions">
		<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></svg>
	</button>
	{#if !lab.sidebar}
		<button class="icon-btn show-rail" onclick={() => (lab.sidebar = true)} title={`Show the sidebar (${mac ? "⌃⌘S" : "Ctrl+Shift+S"})`} aria-label="Show the sidebar">
			<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6 2.5v11" /></svg>
		</button>
	{/if}
	<div class="heading">
		{#if editingTitle}
			<!-- svelte-ignore a11y_autofocus -->
			<input class="title-input" bind:value={titleDraft} onblur={() => finishRename()} onkeydown={(e) => (e.key === "Enter" ? finishRename() : e.key === "Escape" && finishRename(false))} autofocus aria-label="Session title" />
		{:else}
			<button class="title" ondblclick={startRename} onclick={startRename} title="Rename">{lab.summary?.title ?? "Session"}</button>
		{/if}
		<span class="crumb">
			{#if lab.summary?.parent}
				<button class="back" onclick={() => lab.go(lab.summary!.parent!)}>Subagent of the lead session</button>
			{:else}
				<span class="place-dot" class:local={lab.place.id === "local"} style:--dot={`var(${lab.place.color})`}></span>
				<span>{lab.place.id === "local" ? lab.place.title : `${lab.place.title} sandbox`}</span>
				<span class="sep">·</span>
				<span class="folder" title={lab.summary?.cwd}>{project}{branch ? ` · ${branch}` : ""}</span>
			{/if}
		</span>
	</div>
	<button class="icon-btn" onclick={(e) => showMenu(sessionMenu(), e.currentTarget as HTMLElement)} aria-haspopup="menu" title="More" aria-label="More session actions">
		<svg viewBox="0 0 16 16"><circle cx="4" cy="8" r="0.6" /><circle cx="8" cy="8" r="0.6" /><circle cx="12" cy="8" r="0.6" /></svg>
	</button>
	<button class="icon-btn" class:on={lab.workbench} onclick={() => lab.toggleWorkbench()} aria-pressed={lab.workbench} title={`Workbench (${mac ? "⌘\\" : "Ctrl+\\"})`} aria-label="Workbench">
		<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M10 2.5v11" /></svg>
	</button>
</header>

<div class="sheet" bind:this={scroller} onscroll={onScroll}>
	<div class="column">
		{#if !items.length && !lab.busy}
			<div class="blank">
				<p class="blank-title">{lab.model ? lab.model.id : "No model yet"}</p>
				<p class="blank-text">{lab.place.id === "local" ? `Works in ${lab.summary?.cwd ?? ""} on ${lab.place.title}, contained by the operating system.` : `Works in the ${lab.place.title} sandbox; code and files stay there.`}</p>
			</div>
		{/if}
		{#each items as item (item.id)}
			{#if item.kind === "prompt"}
				<h3 class="prompt" class:enter={!lab.openedAt}>{item.text}{#if item.images}<span class="attached"> · {item.images} image{item.images === 1 ? "" : "s"}</span>{/if}</h3>
			{:else if item.kind === "thinking"}
				<div class="thought">
					<button class="thought-line" onclick={() => (thinkingOpen[item.id] = !thinkingOpen[item.id])} aria-expanded={Boolean(thinkingOpen[item.id])}>
						<span class="caret" class:open={thinkingOpen[item.id]}></span>Thought
					</button>
					{#if thinkingOpen[item.id]}<p class="thought-text">{item.text.trim()}</p>{/if}
				</div>
			{:else if item.kind === "activity"}
				<Activity steps={item.steps} live={lab.busy && item.id === lastActivity} />
			{:else if item.kind === "answer"}
				{#if item.text}
					<div class="prose answer" use:codeBlocks={item.text}>{@html renderMarkdown(item.text)}</div>
				{/if}
				{#if item.stop === "error"}
					<p class="mark-line bad">The model stopped with an error: {item.error}</p>
				{:else if item.stop === "cancelled"}
					<p class="mark-line">Stopped.</p>
				{/if}
			{:else if item.kind === "notice"}
				<p class="mark-line" class:bad={item.level === "error"}>{item.text}</p>
			{:else if item.kind === "rule"}
				<div class="rule"><span>{item.text}</span></div>
			{/if}
		{/each}
		{#each orphanApprovals as request (request.requestId)}
			<Approval {request} />
		{/each}
		{#if undoable.length && !lab.busy}
			<button class="undo" onclick={() => lab.undo()} title={undoable.join(", ")}>Undo changes to {undoable.length === 1 ? undoable[0] : `${undoable.length} files`}</button>
		{/if}
		{#if lab.busy}
			<div class="live-area" aria-live="polite">
				{#if lab.partial.reasoning && !lab.partial.text}
					<p class="thinking">{thinkingTail}</p>
				{/if}
				{#if lab.partial.text}
					<div class="prose answer" use:codeBlocks={streaming.settled.length}>
						{#each streaming.settled as block, i (i)}{@html renderMarkdown(block)}{/each}{@html renderPartial(streaming.open)}
					</div>
				{/if}
				{#each lab.partial.tools as call (call.index)}
					<Step running={{ verb: call.name || "…", target: argPreview(call.args), writing: true }} live />
				{/each}
				<p class="activity">
					<span class="dot"></span>
					{activityWord[lab.status?.activity ?? ""] ?? "Working"}
					<span class="faint">{startedAt ? `${Math.max(0, Math.floor((now - startedAt) / 1000))}s` : ""}{lab.status?.detail && lab.status.activity !== "writing" ? ` · ${lab.status.detail}` : ""}</span>
					{#if lab.status?.queued}<span class="faint"> · {lab.status.queued} message{lab.status.queued === 1 ? "" : "s"} waiting to join</span>{/if}
				</p>
			</div>
		{/if}
	</div>
</div>

<Composer />

<style>
	.head {
		position: relative;
		gap: 6px;
		padding: 0 10px 0 20px;
		border-bottom: 1px solid var(--rule);
	}
	/* With the sidebar hidden, the traffic lights sit in this row. */
	:global(.shell.mac.desktop) .head.inset {
		padding-left: 84px;
	}
	.head.inset {
		padding-left: 10px;
	}
	.icon-btn circle {
		fill: currentColor;
		stroke-width: 1.2;
	}
	/* The place line: where this session's work runs, as a 2 px marker across the top. */
	.head::before {
		content: "";
		position: absolute;
		inset: 0 0 auto;
		height: 2px;
		background: var(--marker);
		transform-origin: left;
	}
	.head.moving::before {
		animation: sweep 1.6s var(--ease-out);
	}
	@keyframes sweep {
		from {
			transform: scaleX(0);
		}
		to {
			transform: scaleX(1);
		}
	}
	.menu-toggle {
		display: none;
	}
	.heading {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 1px;
	}
	.heading .title {
		justify-self: start;
		max-width: 100%;
		border-radius: 5px;
		padding: 0 4px;
		margin-left: -4px;
	}
	.heading .title:hover {
		background: var(--hover);
	}
	.title,
	.title-input {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.008em;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}
	.title-input {
		border: 0;
		outline: none;
		background: var(--hover);
		border-radius: 4px;
		padding: 0 4px;
	}
	.crumb {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: 11.5px;
		color: var(--text-muted);
		white-space: nowrap;
	}
	.crumb .place-dot {
		width: 7px;
		height: 7px;
	}
	.crumb .sep {
		color: var(--text-faint);
	}
	.crumb .folder {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.back {
		color: var(--accent-text);
		font-size: 12px;
	}
	.icon-btn.on {
		color: var(--text);
		background: var(--selected);
	}
	.sheet {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		scrollbar-gutter: stable;
	}
	.column {
		max-width: 820px;
		margin: 0 auto;
		padding: 28px 32px 40px;
	}
	.blank {
		padding: 18vh 0 0;
		text-align: center;
	}
	.blank-title {
		margin: 0 0 6px;
		font-family: var(--font-display);
		font-size: 17px;
		font-weight: 600;
	}
	.blank-text {
		margin: 0 auto;
		max-width: 46ch;
		color: var(--text-muted);
		font-size: 13.5px;
	}
	.prompt {
		margin: 30px 0 14px;
		font-family: var(--font-display);
		font-size: 18px;
		line-height: 1.35;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--prompt);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.prompt:first-child {
		margin-top: 4px;
	}
	.attached {
		font-weight: 400;
		color: var(--text-faint);
		font-size: 13px;
	}
	.answer {
		margin: 14px 0;
	}
	.thought {
		margin: 6px 0;
	}
	.thought-line {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--text-faint);
	}
	.thought-line:hover {
		color: var(--text-muted);
	}
	.caret {
		width: 0;
		height: 0;
		border-left: 4px solid currentColor;
		border-top: 3.5px solid transparent;
		border-bottom: 3.5px solid transparent;
		transition: transform 140ms var(--ease-out);
	}
	.caret.open {
		transform: rotate(90deg);
	}
	.thought-text,
	.thinking {
		margin: 6px 0 10px;
		padding-left: 12px;
		border-left: 1px solid var(--rule-strong);
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-faint);
		white-space: pre-wrap;
		max-width: var(--measure);
	}
	.mark-line {
		margin: 10px 0;
		font-size: 13px;
		color: var(--text-muted);
	}
	.mark-line.bad {
		color: var(--bad);
	}
	.rule {
		display: flex;
		align-items: center;
		gap: 12px;
		margin: 22px 0;
		font-size: 12px;
		color: var(--text-faint);
	}
	.rule::before,
	.rule::after {
		content: "";
		flex: 1;
		height: 1px;
		background: var(--rule);
	}
	.undo {
		margin: 4px 0 8px;
		font-size: 13px;
		color: var(--accent-text);
	}
	.undo:hover {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.activity {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 14px 0 0;
		font-size: 13px;
		color: var(--text-muted);
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--live);
	}
	.faint {
		color: var(--text-faint);
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 860px) {
		.menu-toggle {
			display: inline-grid;
		}
		.head {
			padding-left: 8px;
		}
		.column {
			padding: 20px 18px 32px;
		}
	}
</style>
