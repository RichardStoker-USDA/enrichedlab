<script lang="ts">
	// The page-drawn context menu, for the web surface in a plain browser. The desktop app shows native menus
	// instead (lib/menu.svelte.ts). Arrow keys move, Enter or Space chooses, Escape or a click outside closes.
	import { tick } from "svelte";
	import { pageMenu, type MenuAction } from "../lib/menu.svelte.ts";

	let root: HTMLDivElement | undefined = $state();
	let open = $state<number | undefined>();
	let x = $state(0);
	let y = $state(0);

	const current = $derived(pageMenu.current);

	$effect(() => {
		if (!current) return;
		open = undefined;
		x = current.x;
		y = current.y;
		void tick().then(() => {
			if (!root) return;
			// Keep the whole menu on screen.
			const box = root.getBoundingClientRect();
			x = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
			y = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
			root.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
		});
	});

	function close(id?: string) {
		const pending = pageMenu.current;
		pageMenu.current = undefined;
		pending?.resolve(id);
	}

	function move(e: KeyboardEvent) {
		if (!root) return;
		const items = [...root.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
		const at = items.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === "Escape") {
			e.preventDefault();
			close();
		} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
			items[next]?.focus();
		} else if (e.key === "Home" || e.key === "End") {
			e.preventDefault();
			(e.key === "Home" ? items[0] : items.at(-1))?.focus();
		} else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			(document.activeElement as HTMLButtonElement | null)?.click();
		} else if (e.key === "Tab") {
			e.preventDefault();
		}
	}

	function choose(entry: MenuAction, id: string, index: number) {
		if (entry.submenu) open = open === index ? undefined : index;
		else close(id);
	}
</script>

{#if current}
	<button class="backdrop" tabindex="-1" aria-label="Close menu" onpointerdown={() => close()} oncontextmenu={(e) => (e.preventDefault(), close())}></button>
	<div class="menu context" role="menu" tabindex="-1" bind:this={root} style:left={`${x}px`} style:top={`${y}px`} onkeydown={move}>
		{#each current.entries as entry, i (i)}
			{#if entry.separator}
				<hr class="menu-sep" />
			{:else}
				<button
					type="button"
					class="menu-item"
					class:active={open === i}
					role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
					aria-checked={entry.checked === undefined ? undefined : entry.checked}
					aria-haspopup={entry.submenu ? "menu" : undefined}
					aria-expanded={entry.submenu ? open === i : undefined}
					disabled={entry.disabled}
					onclick={() => choose(entry, String(i), i)}
					onkeydown={(e) => e.key === "ArrowRight" && entry.submenu && (open = i)}
				>
					<span class="check" aria-hidden="true">{entry.checked ? "✓" : ""}</span>
					<span>{entry.label}</span>
					<span class="meta" aria-hidden="true">{entry.submenu ? "›" : ""}</span>
				</button>
				{#if entry.submenu && open === i}
					<div class="sub" role="group" aria-label={entry.label}>
						{#each entry.submenu as child, j (j)}
							{#if child.separator}
								<hr class="menu-sep" />
							{:else}
								<button type="button" class="menu-item" role="menuitem" disabled={child.disabled} onclick={() => close(`${i}.${j}`)}>
									<span class="check" aria-hidden="true">{child.checked ? "✓" : ""}</span>
									<span>{child.label}</span>
									<span></span>
								</button>
							{/if}
						{/each}
					</div>
				{/if}
			{/if}
		{/each}
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 90;
		cursor: default;
	}
	.context {
		position: fixed;
		z-index: 91;
		min-width: 220px;
		max-width: 320px;
	}
	.sub {
		margin: 2px 0 2px 14px;
		padding-left: 6px;
		border-left: 1px solid var(--rule);
	}
	.check {
		font-size: 12px;
	}
</style>
