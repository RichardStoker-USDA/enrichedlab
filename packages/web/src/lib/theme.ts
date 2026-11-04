// Color tokens are written with light-dark(), so reading a custom property returns that expression, not a color.
// Canvas drawing, the terminal and apps in frames need the color itself, resolved for the current mode.

/** A color token (`--text`, `--canvas`) as the browser resolves it here and now, in rgb() form. */
export function tokenColor(name: string, scope: Element = document.documentElement): string {
	const probe = document.createElement("span");
	probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:var(${name})`;
	scope.appendChild(probe);
	const value = getComputedStyle(probe).color;
	probe.remove();
	return value;
}

/** Calls `change` whenever light or dark mode changes, from the app's setting or the system's. Returns the stop. */
export function onThemeChange(change: () => void): () => void {
	const media = matchMedia("(prefers-color-scheme: dark)");
	const observer = new MutationObserver(change);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	media.addEventListener("change", change);
	return () => {
		observer.disconnect();
		media.removeEventListener("change", change);
	};
}
