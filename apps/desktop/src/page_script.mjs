// The agent's hands on a web page, shared by both browsers: the desktop app's browser pane (main.mjs) and a lab
// sandbox's browser, driven by the engine over the DevTools protocol. Each is a script run in an isolated world, so the
// page can't change what it sees or returns. A page reads as text with numbered controls; clicks and typing then name
// a control by its number.

export const SNAPSHOT = `(() => {
	const lines = [];
	let n = 0;
	const clean = (t) => (t || "").replace(/\\s+/g, " ").trim();
	const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
	const CONTROL = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=''],[contenteditable=true]";
	const label = (el) => clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.innerText || el.getAttribute("name") || "").slice(0, 90);
	const describe = (el) => {
		const tag = el.tagName.toLowerCase();
		const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "select" ? "select" : tag === "textarea" ? "textbox" : tag === "input" ? ({ checkbox: "checkbox", radio: "radio", submit: "button", button: "button", file: "file" }[el.type] || "textbox") : tag === "summary" ? "button" : tag === "button" ? "button" : "control");
		let extra = "";
		if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) extra = el.checked ? " (checked)" : " (not checked)";
		else if (tag === "input" && el.type === "password") extra = el.value ? " = ••••" : " (empty)";
		else if (tag === "input" || tag === "textarea") extra = el.value ? " = " + JSON.stringify(el.value.slice(0, 120)) : " (empty)";
		else if (tag === "select") extra = " = " + JSON.stringify(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : "") + " of " + [...el.options].slice(0, 12).map((o) => clean(o.text)).join(" | ");
		else if (tag === "a") extra = " -> " + el.getAttribute("href").slice(0, 100);
		if (el.disabled) extra += " (disabled)";
		return role + " " + JSON.stringify(label(el)) + extra;
	};
	document.querySelectorAll("[data-agent-ref]").forEach((e) => e.removeAttribute("data-agent-ref"));
	const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
	for (let el = walker.currentNode; el; el = walker.nextNode()) {
		if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(el.tagName)) continue;
		if (el.matches(CONTROL)) {
			if (!shown(el) || el.closest("[data-agent-ref]")) continue;
			el.setAttribute("data-agent-ref", String(++n));
			lines.push("[" + n + "] " + describe(el));
		} else if (/^H[1-6]$/.test(el.tagName)) {
			if (shown(el)) lines.push("#".repeat(Number(el.tagName[1])) + " " + clean(el.innerText).slice(0, 160));
		} else if (!el.closest(CONTROL) && !/^H[1-6]$/.test(el.tagName) && !el.closest("h1,h2,h3,h4,h5,h6")) {
			let own = "";
			for (const child of el.childNodes) if (child.nodeType === 3) own += child.textContent;
			own = clean(own);
			if (own.length > 1 && shown(el)) lines.push(own.slice(0, 400));
		}
		if (lines.join("\\n").length > 14000) { lines.push("… (page continues; scroll or click to see more)"); break; }
	}
	return lines.join("\\n");
})()`;

/** Scroll control `ref` into view; its center in viewport pixels, or null when it's gone. */
export const centerScript = (ref) =>
	`(() => { const el = document.querySelector('[data-agent-ref="${Number(ref)}"]'); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;

/** Focus field `ref` and select what's in it, so typed text replaces it; false when it's gone. */
export const focusScript = (ref) =>
	`(() => { const el = document.querySelector('[data-agent-ref="${Number(ref)}"]'); if (!el) return false; el.scrollIntoView({ block: "center" }); el.focus(); if (el.select) el.select(); else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } return true; })()`;
