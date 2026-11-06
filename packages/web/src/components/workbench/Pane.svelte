<script lang="ts">
	import type { Tab } from "../../lib/layout.ts";
	import BrowserPane from "../panes/BrowserPane.svelte";
	import ScreenPane from "../panes/ScreenPane.svelte";
	import DesktopPane from "../panes/DesktopPane.svelte";
	import FilesPane from "../panes/FilesPane.svelte";
	import PlotPane from "../panes/PlotPane.svelte";
	import TablePane from "../panes/TablePane.svelte";
	import TerminalPane from "../panes/TerminalPane.svelte";
	import ViewPane from "../panes/ViewPane.svelte";
	import AppPane from "../panes/AppPane.svelte";

	import { lab } from "../../lib/store.svelte.ts";

	let { tab, active: front }: { tab: Tab; active: boolean } = $props();
	// The workbench stays mounted while hidden (so terminals and apps keep running); a pane is shown only when its
	// tab is in front, the workbench is open, and no sheet covers it.
	const active = $derived(front && lab.workbench && !lab.covered);
</script>

{#if tab.kind === "view"}
	<ViewPane id={tab.ref ?? ""} />
{:else if tab.kind === "table"}
	<TablePane id={tab.ref ?? ""} />
{:else if tab.kind === "plot"}
	<PlotPane id={tab.ref ?? ""} {active} />
{:else if tab.kind === "terminal"}
	<TerminalPane {active} />
{:else if tab.kind === "browser"}
	<BrowserPane id={tab.id} url={tab.ref} {active} />
{:else if tab.kind === "screen"}
	<ScreenPane site={tab.ref ?? ""} {active} />
{:else if tab.kind === "desktop"}
	<DesktopPane site={tab.ref ?? ""} {active} />
{:else if tab.kind === "files"}
	<FilesPane />
{:else if tab.kind === "app"}
	<AppPane id={tab.ref ?? ""} {active} />
{/if}
