#if DEBUG
import AppKit
import EnrichedLabKit
import SwiftUI

/// Scenes for scripts/dev_lab.ts --mac: put the window in a known state from the environment, then print the window
/// numbers so the script can capture this app's windows (and only them). Debug builds only.
///
/// EL_SCENE_SESSION  a session id to open
/// EL_SCENE_PANE     files, terminal, browser, desktop, or first (the newest view)
/// EL_SCENE_SETTINGS general, models, labs or updates: open Settings on that tab
/// EL_SCENE_SIZE     the window's content size, such as 1360x880
/// EL_SCENE_ADVANCED 1 to show advanced controls
/// EL_SCENE_AFTER    milliseconds to wait before saying the scene is ready
@MainActor
enum Automation {
	static var active: Bool { ProcessInfo.processInfo.environment["EL_SCENE"] != nil }

	static func run(app: AppModel, openSettings: OpenSettingsAction) async {
		let env = ProcessInfo.processInfo.environment
		guard env["EL_SCENE"] != nil else { return }
		UserDefaults.standard.set(env["EL_SCENE_ADVANCED"] == "1", forKey: "advanced")
		for _ in 0 ..< 100 where !app.connected { try? await Task.sleep(for: .milliseconds(100)) }
		if let size = env["EL_SCENE_SIZE"]?.split(separator: "x").compactMap({ Double($0) }), size.count == 2, let window = mainWindow {
			window.setContentSize(NSSize(width: size[0], height: size[1]))
			window.center()
		}
		if let id = env["EL_SCENE_SESSION"] {
			app.selection = id
			for _ in 0 ..< 100 where app.session?.id != id || app.session?.opening == true { try? await Task.sleep(for: .milliseconds(100)) }
		}
		if let pane = env["EL_SCENE_PANE"], let session = app.session {
			switch pane {
			case "files": session.workbench.show(.files, title: "Files")
			case "terminal": session.workbench.newTerminal()
			case "browser": session.workbench.show(.browser, title: "Browser")
			case "desktop": if let site = session.place.site { session.workbench.show(.desktop(site: site.name), title: "\(session.place.title) desktop") }
			case "first": if let view = session.canvases.first { session.showView(view.id) }
			default: break
			}
		}
		if let tab = env["EL_SCENE_SETTINGS"].flatMap(SettingsTab.init(rawValue:)) {
			app.showSettingsTab = tab
			openSettings()
		}
		try? await Task.sleep(for: .milliseconds(Double(env["EL_SCENE_AFTER"] ?? "1500") ?? 1500))
		for window in NSApp.windows where window.isVisible && window.frame.width > 200 {
			print("scene: window \(window.windowNumber) \(window.identifier?.rawValue ?? window.title)")
		}
		print("scene: ready")
		fflush(stdout)
	}

	private static var mainWindow: NSWindow? {
		NSApp.windows.first { $0.isVisible && $0.frame.width > 400 && !$0.title.contains("Settings") }
	}
}
#endif
