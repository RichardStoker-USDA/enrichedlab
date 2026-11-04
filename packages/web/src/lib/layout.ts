// The workbench layout: a tree of splits whose leaves are tab groups. Pure functions over plain data, so the layout
// can be stored per session and every change is easy to reason about and test.

export type PaneKind = "view" | "table" | "plot" | "browser" | "screen" | "terminal" | "files" | "app";

export interface Tab {
	id: string;
	kind: PaneKind;
	title: string;
	/** What the pane shows: a view id for view, table and plot; an address for browser; a lab for screen (its sandbox browser). */
	ref?: string;
}

export interface Group {
	type: "group";
	id: string;
	tabs: Tab[];
	active: string;
}

export interface Split {
	type: "split";
	id: string;
	/** row: side by side; column: stacked. */
	dir: "row" | "column";
	/** Fractions that add up to 1, one per child. */
	sizes: number[];
	children: Node[];
}

export type Node = Group | Split;
export type Edge = "left" | "right" | "top" | "bottom" | "center";

let counter = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function emptyLayout(): Group {
	return { type: "group", id: uid("g"), tabs: [], active: "" };
}

export function groups(node: Node): Group[] {
	return node.type === "group" ? [node] : node.children.flatMap(groups);
}

export function allTabs(node: Node): Tab[] {
	return groups(node).flatMap((g) => g.tabs);
}

export function findTab(node: Node, test: (tab: Tab) => boolean): { group: Group; tab: Tab } | undefined {
	for (const group of groups(node)) {
		const tab = group.tabs.find(test);
		if (tab) return { group, tab };
	}
	return undefined;
}

/** Rebuild the tree bottom-up: children first, then `fn` on the node, so a node `fn` replaces isn't visited again. */
function map(node: Node, fn: (node: Node) => Node): Node {
	return fn(node.type === "split" ? { ...node, children: node.children.map((c) => map(c, fn)) } : node);
}

/** Drop empty groups and splits with one child, and keep sizes summing to 1. */
export function normalize(node: Node): Node {
	if (node.type === "group") return node;
	const kept: { child: Node; size: number }[] = [];
	node.children.forEach((child, i) => {
		const next = normalize(child);
		if (next.type === "group" && next.tabs.length === 0) return;
		kept.push({ child: next, size: node.sizes[i] ?? 1 / node.children.length });
	});
	if (kept.length === 0) return emptyLayout();
	if (kept.length === 1) return kept[0].child;
	const total = kept.reduce((sum, k) => sum + k.size, 0) || 1;
	return { ...node, children: kept.map((k) => k.child), sizes: kept.map((k) => k.size / total) };
}

/** Show a tab: activate it where it already is, else add it to `groupId` (or the first group). */
export function open(root: Node, tab: Tab, groupId?: string): Node {
	const found = findTab(root, (t) => t.kind === tab.kind && (tab.ref ? t.ref === tab.ref : t.id === tab.id));
	if (found) return activate(root, found.tab.id, tab.title);
	const target = (groupId && groups(root).find((g) => g.id === groupId)) || groups(root)[0]!;
	return map(root, (n) => (n.type === "group" && n.id === target.id ? { ...n, tabs: [...n.tabs, tab], active: tab.id } : n));
}

export function activate(root: Node, tabId: string, title?: string): Node {
	return map(root, (n) =>
		n.type === "group" && n.tabs.some((t) => t.id === tabId)
			? { ...n, active: tabId, tabs: title ? n.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)) : n.tabs }
			: n,
	);
}

export function close(root: Node, tabId: string): Node {
	const next = map(root, (n) => {
		if (n.type !== "group" || !n.tabs.some((t) => t.id === tabId)) return n;
		const index = n.tabs.findIndex((t) => t.id === tabId);
		const tabs = n.tabs.filter((t) => t.id !== tabId);
		const active = n.active === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? "") : n.active;
		return { ...n, tabs, active };
	});
	return normalize(next);
}

/** Move a tab next to (or into) a group. An edge splits the target group on that side. */
export function move(root: Node, tabId: string, targetGroupId: string, edge: Edge): Node {
	const found = findTab(root, (t) => t.id === tabId);
	if (!found) return root;
	const { tab, group: source } = found;
	if (edge === "center" && source.id === targetGroupId) return activate(root, tabId);
	if (edge !== "center" && source.id === targetGroupId && source.tabs.length === 1) return root;
	const without = map(root, (n) => (n.type === "group" && n.id === source.id ? { ...n, tabs: n.tabs.filter((t) => t.id !== tabId), active: n.active === tabId ? (n.tabs.find((t) => t.id !== tabId)?.id ?? "") : n.active } : n));
	const placed = map(without, (n) => {
		if (n.type !== "group" || n.id !== targetGroupId) return n;
		if (edge === "center") return { ...n, tabs: [...n.tabs, tab], active: tab.id };
		const fresh: Group = { type: "group", id: uid("g"), tabs: [tab], active: tab.id };
		const before = edge === "left" || edge === "top";
		return { type: "split", id: uid("s"), dir: edge === "left" || edge === "right" ? "row" : "column", sizes: [0.5, 0.5], children: before ? [fresh, n] : [n, fresh] };
	});
	return normalize(placed);
}

export function resize(root: Node, splitId: string, sizes: number[]): Node {
	return map(root, (n) => (n.type === "split" && n.id === splitId ? { ...n, sizes } : n));
}

/** Rename tabs whose view changed title, and drop tabs whose view is gone. */
export function sync(root: Node, views: Map<string, string>): Node {
	const next = map(root, (n) => {
		if (n.type !== "group") return n;
		const tabs = n.tabs
			.filter((t) => !["view", "table", "plot"].includes(t.kind) || (t.ref && views.has(t.ref)))
			.map((t) => (t.ref && views.has(t.ref) ? { ...t, title: views.get(t.ref)! } : t));
		return { ...n, tabs, active: tabs.some((t) => t.id === n.active) ? n.active : (tabs[0]?.id ?? "") };
	});
	return normalize(next);
}

/** A stored layout, checked enough that a damaged one falls back to empty. */
export function revive(value: unknown): Node {
	const ok = (n: unknown): n is Node => {
		if (!n || typeof n !== "object") return false;
		const node = n as Node;
		if (node.type === "group") return Array.isArray(node.tabs);
		return node.type === "split" && Array.isArray(node.children) && node.children.every(ok) && Array.isArray(node.sizes);
	};
	return ok(value) ? normalize(value) : emptyLayout();
}
