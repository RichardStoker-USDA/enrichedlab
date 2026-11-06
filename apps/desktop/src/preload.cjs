// The only bridge between the web surface and the shell: the platform, a native folder picker, native menus (the
// menu bar's commands, the page's context menus), the appearance choice, and the browser pane's views (shown over a
// pane's rectangle, driven by its address bar).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("labDesktop", {
	platform: process.platform,
	pickFolder: () => ipcRenderer.invoke("pick-folder"),
	menu: (entries, at) => ipcRenderer.invoke("menu:popup", entries, at),
	reveal: (path) => ipcRenderer.invoke("reveal", path),
	setTheme: (theme) => ipcRenderer.send("theme", theme),
	closeWindow: () => ipcRenderer.send("window:close"),
	menuState: (state) => ipcRenderer.send("menu:state", state),
	onFullscreen: (listener) => {
		const handler = (_event, on) => listener(Boolean(on));
		ipcRenderer.on("fullscreen", handler);
		return () => ipcRenderer.removeListener("fullscreen", handler);
	},
	onCommand: (listener) => {
		const handler = (_event, command) => listener(command);
		ipcRenderer.on("command", handler);
		return () => ipcRenderer.removeListener("command", handler);
	},
	browser: {
		show: (id, url, bounds) => ipcRenderer.send("browser:show", id, url, bounds),
		bounds: (id, bounds) => ipcRenderer.send("browser:bounds", id, bounds),
		hide: (id) => ipcRenderer.send("browser:hide", id),
		navigate: (id, url) => ipcRenderer.send("browser:navigate", id, url),
		go: (id, step) => ipcRenderer.send("browser:go", id, step),
		close: (id) => ipcRenderer.send("browser:close", id),
		agent: (id, op, args) => ipcRenderer.invoke("browser:agent", id, op, args),
		onState: (listener) => {
			const handler = (_event, id, state) => listener(id, state);
			ipcRenderer.on("browser:state", handler);
			return () => ipcRenderer.removeListener("browser:state", handler);
		},
	},
});
