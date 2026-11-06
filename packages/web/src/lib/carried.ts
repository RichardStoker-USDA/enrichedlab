// What the desktop shell carried across an engine restart: the old page's storage belonged to the old address.

let adopted = false;

/** Once per page: drafts go back to sessionStorage, layouts to localStorage; nothing replaces what's already here. */
export function adoptCarried(): void {
	if (adopted) return;
	adopted = true;
	try {
		for (const [key, value] of Object.entries(window.labDesktop?.takeDrafts?.() ?? {})) {
			const area = key.startsWith("enrichedlab.draft.") ? sessionStorage : localStorage;
			if (area.getItem(key) === null) area.setItem(key, value);
		}
	} catch {
		// Nothing carried, or storage blocked.
	}
}
