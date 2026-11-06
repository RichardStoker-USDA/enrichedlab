// Context menus: native in the desktop app, drawn by the page (ContextMenu.svelte) in a browser. Every area that
// has things to act on (a session, a place, a tab, a file) offers them on right-click and on its "More" button,
// through this one helper, so the two always match.

export interface MenuEntry {
	id?: string;
	label?: string;
	disabled?: boolean;
	checked?: boolean;
	/** One choice of several (a place, a level): drawn as a radio item. */
	radio?: true;
	separator?: true;
	submenu?: MenuEntry[];
}

export interface MenuAction extends MenuEntry {
	run?: () => unknown;
	submenu?: MenuAction[];
}

export const separator: MenuAction = { separator: true };

interface Pending {
	entries: MenuAction[];
	x: number;
	y: number;
	resolve: (id: string | undefined) => void;
}

/** The page-drawn menu now showing, if any (read by ContextMenu.svelte). */
export const pageMenu = $state<{ current?: Pending }>({});

function strip(entries: MenuAction[], prefix = ""): MenuEntry[] {
	return entries.map((e, i) => (e.separator ? { separator: true } : { id: `${prefix}${i}`, label: e.label, disabled: e.disabled, checked: e.checked, radio: e.radio, submenu: e.submenu ? strip(e.submenu, `${prefix}${i}.`) : undefined }));
}

function find(entries: MenuAction[], id: string): MenuAction | undefined {
	const [head, ...rest] = id.split(".");
	const entry = entries[Number(head)];
	return rest.length && entry?.submenu ? find(entry.submenu, rest.join(".")) : entry;
}

/** Show a menu at the pointer (or under an element) and run the chosen entry. */
export async function showMenu(entries: MenuAction[], at: MouseEvent | HTMLElement): Promise<void> {
	const list = entries.filter((e, i, all) => !(e.separator && (i === 0 || all[i - 1]?.separator || i === all.length - 1)));
	if (!list.length) return;
	let x: number;
	let y: number;
	if (at instanceof MouseEvent) {
		at.preventDefault();
		at.stopPropagation();
		x = at.clientX;
		y = at.clientY;
	} else {
		const box = at.getBoundingClientRect();
		x = box.left;
		y = box.bottom + 4;
	}
	const native = typeof window !== "undefined" ? window.labDesktop?.menu : undefined;
	const id = native ? await native(strip(list), { x, y }) : await new Promise<string | undefined>((resolve) => (pageMenu.current = { entries: list, x, y, resolve }));
	if (id === undefined || id === "") return;
	await find(list, id)?.run?.();
}

/** A Svelte action: right-click (or the menu key, or Shift+F10) on the element opens its menu. */
export function contextMenu(node: HTMLElement, entries: () => MenuAction[]) {
	let get = entries;
	const open = (e: MouseEvent) => void showMenu(get(), e);
	const key = (e: KeyboardEvent) => {
		if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
			const list = get();
			if (!list.length) return;
			// The innermost menu wins, as with a right-click.
			e.preventDefault();
			e.stopPropagation();
			void showMenu(list, node);
		}
	};
	node.addEventListener("contextmenu", open);
	node.addEventListener("keydown", key);
	return {
		update(next: () => MenuAction[]) {
			get = next;
		},
		destroy() {
			node.removeEventListener("contextmenu", open);
			node.removeEventListener("keydown", key);
		},
	};
}
