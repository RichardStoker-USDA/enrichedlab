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
