<script lang="ts">
	import type { SessionEvent } from "@enrichedlab/protocol";
	import { lab } from "../lib/store.svelte.ts";

	type Tool = Extract<SessionEvent, { t: "tool" }>;
	let {
		event,
		running,
		live = false,
	}: {
		event?: Tool;
		running?: { verb: string; target: string; output?: string; waiting?: boolean; writing?: boolean };
		live?: boolean;
	} = $props();

	let open = $state(false);
	const view = $derived(event?.view ?? (running ? { verb: running.verb, target: running.target } : { verb: "", target: "" }));
	const kind = $derived(
		running ? (running.waiting ? "waiting" : "running") : event?.decision === "denied" ? "denied" : event?.ok ? "ok" : "failed",
	);
	const marks: Record<string, string> = { ok: "✓", failed: "✕", denied: "■", running: "●", waiting: "▲" };
	const words: Record<string, string> = { ok: "done", failed: "failed", denied: "declined", running: "running", waiting: "waiting for you" };
	const result = $derived(running ? (running.writing ? "writing" : running.waiting ? "waiting for you" : "running") : (event?.view?.result ?? words[kind]));
	const hasDetail = $derived(Boolean(event?.view?.diff || event?.view?.detail || (event && !event.ok && event.content)));
	const diffLines = $derived(
		(event?.view?.diff ?? "")
			.split("\n")
			.filter((l) => l && !l.startsWith("---") && !l.startsWith("+++")),
	);
	const outputTail = $derived(running?.output ? running.output.replace(/\s+$/, "").split("\n").slice(-6).join("\n") : "");

	const shown = $derived(event?.view?.canvas ? lab.canvases.find((c) => c.id === event!.view!.canvas) : undefined);
	const openLabel = $derived(shown ? (({ table: "Open table", plot: "Open plot", page: "Open app", image: "Open figure" }) as Record<string, string>)[shown.kind] ?? "Open view" : "Open view");
</script>

<div class="step" class:enter={!event || Date.parse(event.at) > lab.openedAt} class:live class:failed={kind === "failed"} class:waiting={kind === "waiting"} data-state={kind}>
	<button class="line" onclick={() => hasDetail && (open = !open)} aria-expanded={hasDetail ? open : undefined} disabled={!hasDetail}>
		<span class="verb">{view.verb}</span>
		<span class="target" title={view.target}>{view.target}</span>
		<span class="result">{result}</span>
		<span class="mark" aria-label={words[kind]}>{marks[kind]}</span>
	</button>
	{#if event?.view?.canvas}
		<button class="canvas-link" onclick={() => lab.showView(event!.view!.canvas!)}>{openLabel}</button>
	{/if}
	{#if event?.view?.session}
		<button class="canvas-link" onclick={() => lab.go(event.view!.session!)}>Watch the subagent</button>
	{/if}
	{#if outputTail}
		<pre class="output">{outputTail}</pre>
	{/if}
	{#if open && event}
		<div class="detail">
			{#if diffLines.length}
				<pre class="diff">{#each diffLines as line}<span class:add={line.startsWith("+")} class:del={line.startsWith("-")} class:hunk={line.startsWith("@@")}>{line}
</span>{/each}</pre>
			{:else}
				<pre class="output">{event.view?.detail ?? event.content}</pre>
			{/if}
		</div>
	{:else if event?.view?.diff && diffLines.length <= 12}
		<pre class="diff compact">{#each diffLines as line}<span class:add={line.startsWith("+")} class:del={line.startsWith("-")} class:hunk={line.startsWith("@@")}>{line}
</span>{/each}</pre>
	{/if}
</div>

<style>
	.step {
		position: relative;
		padding-left: 18px;
	}
	/* Only steps that arrive while the person watches move in; history opens still. */
	.step.enter {
		animation: enter 180ms var(--ease-out);
	}
	/* The rail: a thin rule in the gutter; the newest step's segment carries the live color while work runs. */
	.step::before {
		content: "";
		position: absolute;
		left: 4px;
		top: 0;
		bottom: 0;
		width: 1.5px;
		background: var(--rule-strong);
		transform-origin: top;
	}
	.step.live::before {
		background: var(--live);
		animation: grow 180ms var(--ease-out);
	}
	.step.waiting::after {
		content: "";
		position: absolute;
		left: 0;
		top: 9px;
		width: 10px;
		height: 10px;
		background: var(--notch);
		border: 1.5px solid var(--notch-edge);
		transform: rotate(45deg);
		border-radius: 2px;
	}
	.line {
		width: 100%;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto;
		align-items: baseline;
		gap: 10px;
		padding: 5px 8px;
		margin-left: -8px;
		border-radius: 7px;
		font-family: var(--font-mono);
		font-size: 12.5px;
		line-height: 1.5;
		text-align: left;
		color: var(--text);
		cursor: default;
	}
	.line:not(:disabled) {
		cursor: pointer;
	}
	.line:not(:disabled):hover {
		background: var(--hover);
	}
	.line:disabled {
		opacity: 1;
	}
	.verb {
		color: var(--text-muted);
		min-width: 6ch;
	}
	.target {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.result {
		color: var(--text-faint);
		white-space: nowrap;
	}
	.mark {
		width: 1.2em;
		text-align: center;
		color: var(--ok);
	}
	[data-state="failed"] .mark {
		color: var(--bad);
	}
	[data-state="denied"] .mark {
		color: var(--text-muted);
	}
	[data-state="running"] .mark,
	[data-state="waiting"] .mark {
		color: var(--live);
	}
	.canvas-link {
		font-size: 12px;
		color: var(--link);
		margin: -2px 0 4px;
	}
	pre {
		margin: 2px 0 8px;
		padding: 8px 10px;
		border-radius: 8px;
		background: var(--code-bg);
		font-size: 12px;
		line-height: 1.5;
		overflow-x: auto;
		max-height: 420px;
		overflow-y: auto;
		white-space: pre;
	}
	.output {
		color: var(--text-muted);
	}
	.diff .add {
		color: var(--added);
	}
	.diff .del {
		color: var(--removed);
	}
	.diff .hunk {
		color: var(--text-faint);
	}
	.diff.compact {
		max-height: 220px;
	}
	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
	@keyframes grow {
		from {
			transform: scaleY(0);
		}
	}
	@media (max-width: 560px) {
		.result {
			display: none;
		}
	}
</style>
