import EnrichedLabUI
import SwiftUI

/// The EnrichedLab app for macOS: one window on the person's engine, and Settings.
@main
struct EnrichedLabApp: App {
	@NSApplicationDelegateAdaptor private var delegate: AppDelegate
	@State private var model = AppModel()

	var body: some Scene {
		Window("EnrichedLab", id: "main") {
			RootView()
				.environment(model)
				.frame(minWidth: 720, minHeight: 480)
		}
		.defaultSize(width: 1320, height: 860)
		.windowToolbarStyle(.unified)
		.commands { EnrichedLabCommands(app: model) }

		Settings {
			SettingsView()
				.environment(model)
		}
	}
}

/// A Finder-started app is a regular app: it gets a Dock icon and comes to the front.
final class AppDelegate: NSObject, NSApplicationDelegate {
	func applicationDidFinishLaunching(_ notification: Notification) {
		NSApp.setActivationPolicy(.regular)
		NSApp.activate()
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
