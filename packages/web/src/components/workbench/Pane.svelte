<script lang="ts">
	import type { Tab } from "../../lib/layout.ts";
	import BrowserPane from "../panes/BrowserPane.svelte";
	import ScreenPane from "../panes/ScreenPane.svelte";
	import FilesPane from "../panes/FilesPane.svelte";
	import PlotPane from "../panes/PlotPane.svelte";
	import TablePane from "../panes/TablePane.svelte";
	import TerminalPane from "../panes/TerminalPane.svelte";
	import ViewPane from "../panes/ViewPane.svelte";
	import AppPane from "../panes/AppPane.svelte";

	let { tab, active }: { tab: Tab; active: boolean } = $props();
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
{:else if tab.kind === "files"}
	<FilesPane />
{:else if tab.kind === "app"}
	<AppPane id={tab.ref ?? ""} {active} />
{/if}
