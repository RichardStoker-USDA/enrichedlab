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
/// EL_SCENE_RESIZE   a content size applied after the pane opens (narrowing a window with the workbench open)
/// EL_SCENE_ADVANCED 1 to show advanced controls
/// EL_SCENE_AFTER    milliseconds to wait before saying the scene is ready
/// EL_SCENE_PROMPT   start a new session in the newest project with this task, as the New Session view does
/// EL_SCENE_UNTIL    streaming (a long tool call is arriving), question (it asks), or done (allowed, then finished)
@MainActor
enum Automation {
	static var active: Bool { ProcessInfo.processInfo.environment["EL_SCENE"] != nil }

	static func run(app: AppModel, openSettings: OpenSettingsAction) async {
		let env = ProcessInfo.processInfo.environment
		guard env["EL_SCENE"] != nil else { return }
		UserDefaults.standard.set(env["EL_SCENE_ADVANCED"] == "1", forKey: "advanced")
		for _ in 0 ..< 100 where !app.connected { try? await Task.sleep(for: .milliseconds(100)) }

		// The size comes first: opening the workbench in a narrow window then widens it, as macOS does.
		if let size = env["EL_SCENE_SIZE"]?.split(separator: "x").compactMap({ Double($0) }), size.count == 2, let window = mainWindow {
			window.setContentSize(NSSize(width: size[0], height: size[1]))
			window.center()
		}
		if let prompt = env["EL_SCENE_PROMPT"] { await live(app: app, prompt: prompt, until: env["EL_SCENE_UNTIL"] ?? "done") }
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
		if let size = env["EL_SCENE_RESIZE"]?.split(separator: "x").compactMap({ Double($0) }), size.count == 2, let window = mainWindow {
			try? await Task.sleep(for: .milliseconds(800))
			// As far as a person dragging the window's edge could take it.
			let smallest = window.contentMinSize
			window.setContentSize(NSSize(width: max(size[0], smallest.width), height: max(size[1], smallest.height)))
			print("scene: narrowed to \(Int(window.contentLayoutRect.width)) (smallest \(Int(smallest.width)))")
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

	/// A live turn from the window, measured: how soon output appears, and the longest the main thread was busy.
	private static func live(app: AppModel, prompt: String, until: String) async {
		guard let folder = app.projects.first?.folder else { print("scene: live: no project"); return }
		// The longest the main thread was busy, before the first output (opening the session) and after (streaming).
		var opening: Duration = .zero
		var streaming: Duration = .zero
		var first: Duration?
		var watching = true
		let clock = ContinuousClock()
		let watch = Task { @MainActor in
			while watching {
				let start = clock.now
				try? await Task.sleep(for: .milliseconds(10))
				let stall = clock.now - start - .milliseconds(10)
				if first == nil { opening = max(opening, stall) } else { streaming = max(streaming, stall) }
			}
		}
		let sent = clock.now
		guard await app.create(folder: URL(fileURLWithPath: folder), place: "local", model: nil, prompt: prompt) != nil else { print("scene: live: not started"); return }
		var answered = false
		for _ in 0 ..< 600 {
			guard let session = app.session else { break }
			if first == nil, !session.partial.text.isEmpty || !session.partial.tools.isEmpty || !session.blocks.isEmpty { first = clock.now - sent }
			if until == "streaming", (session.partial.tools.first?.args.count ?? 0) > 4000 { break }
			if until == "question", !session.pending.isEmpty { break }
			if until == "done" {
				if let question = session.pending.first, !answered {
					answered = true
					await session.answer(question, .allow)
				}
				if answered, !session.busy { break }
			}
			try? await Task.sleep(for: .milliseconds(100))
		}
		watching = false
		_ = await watch.value
		let ms = { (d: Duration?) in d.map { String(Int($0.components.seconds * 1000 + $0.components.attoseconds / 1_000_000_000_000_000)) } ?? "none" }
		let session = app.session
		print("scene: live \(until): first output \(ms(first)) ms, longest main-thread stall opening \(ms(opening)) ms, streaming \(ms(streaming)) ms, steps \(session?.blocks.count ?? 0), questions \(session?.pending.count ?? 0), busy \(session?.busy ?? false)")
	}
}
#endif
