/// <reference types="vite/client" />

/** A page shown in the desktop app's own browser view: where it is and whether it can go back or forward. */
interface BrowserState {
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	loading: boolean;
}

interface Window {
	/** Present inside the desktop shell. */
	labDesktop?: {
		pickFolder(): Promise<string | undefined>;
		platform: string;
		/** A native context menu; resolves with the chosen entry's id. */
		menu?(entries: import("./lib/menu.svelte.ts").MenuEntry[]): Promise<string | undefined>;
		/** Show a file or folder in Finder or Explorer. */
		reveal?(path: string): Promise<boolean>;
		/** The appearance choice, so the window material matches the page. */
		setTheme?(theme: "auto" | "light" | "dark"): void;
		/** Close the window (⌘W with no pane open). */
		closeWindow?(): void;
		/** Full screen on or off: the traffic lights hide in full screen. */
		onFullscreen?(listener: (on: boolean) => void): () => void;
		/** Menu bar commands, by id. */
		onCommand?(listener: (command: string) => void): () => void;
		/** Real browser views laid over a pane's rectangle (Electron WebContentsView). */
		browser?: {
			show(id: string, url: string, bounds: { x: number; y: number; width: number; height: number }): void;
			bounds(id: string, bounds: { x: number; y: number; width: number; height: number }): void;
			hide(id: string): void;
			navigate(id: string, url: string): void;
			go(id: string, step: "back" | "forward" | "reload"): void;
			close(id: string): void;
			onState(listener: (id: string, state: BrowserState) => void): () => void;
			/** Act on the pane's page for the agent: open, read, click, type, shot. */
			agent?(id: string, op: string, args: Record<string, unknown>): Promise<{ text: string; image?: { mime: string; data: string } }>;
		};
	};
}
