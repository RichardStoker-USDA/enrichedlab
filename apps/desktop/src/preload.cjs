// The only bridge between the web surface and the shell: the platform, a native folder picker, and the browser pane's
// views (shown over a pane's rectangle, driven by its address bar).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("labDesktop", {
	platform: process.platform,
	pickFolder: () => ipcRenderer.invoke("pick-folder"),
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
