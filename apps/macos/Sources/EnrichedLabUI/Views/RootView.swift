import EnrichedLabKit
import SwiftUI

/// The main window: the sidebar (places and sessions), the session (or a new one), and the workbench beside it.
public struct RootView: View {
	@Environment(AppModel.self) private var app
	@Environment(\.openSettings) private var openSettings
	@State private var columns = NavigationSplitViewVisibility.all
	@State private var window: NSWindow?
	@State private var width: CGFloat = 0
	/// The sidebar stepped aside for the workbench, so it comes back when the workbench closes.
	@State private var sidebarAsideForWorkbench = false
	/// The window is widening to make room: its in-between widths don't move the sidebar.
	@State private var widening = false

	public init() {}

	private var workbenchOpen: Bool { app.session?.workbench.isOpen == true }

	/// The width the sidebar (when shown), the run sheet and the workbench need side by side. The sidebar and the
	/// workbench keep their widths as the window narrows, as in Xcode, so the window's smallest size follows them.
	private var roomy: CGFloat {
		(columns == .detailOnly ? 0 : app.sidebarWidth) + AppModel.runSheetWidth + app.workbenchWidth
	}

	private func measure(_ window: NSWindow) {
		let now = window.contentLayoutRect.width
		width = now
		if widening, now >= roomy - 1 { widening = false }
		updateRoom()
	}

	private func updateRoom() {
		let room = !widening && (width == 0 || width >= roomy - 1 || columns == .detailOnly)
		if app.workbenchRoom != room { app.workbenchRoom = room }
	}

	/// With the workbench showing, the window can't be narrowed past what its columns need.
	private var smallestWidth: CGFloat {
		guard workbenchOpen, app.workbenchRoom else { return 720 }
		return max(720, min(roomy, width > 0 ? width : roomy))
	}

	private func asideSidebar() {
		columns = .detailOnly
		sidebarAsideForWorkbench = true
	}

	/// Room for the workbench when it opens: a wider window when the screen allows (as macOS does), else the
	/// sidebar steps aside.
	private func makeRoom() {
		guard width > 0, width < roomy - 1, columns != .detailOnly else { return }
		if let window, let screen = window.screen, !window.styleMask.contains(.fullScreen) {
			let visible = screen.visibleFrame
			var frame = window.frame
			// The frame is a little wider than the content (the window's edges).
			let wanted = roomy + (frame.width - width)
			let grow = min(wanted, visible.width) - frame.width
			if frame.width + grow >= wanted - 1 {
				frame.size.width += grow
				// Grow to the right, moved left only as far as the screen's edge requires.
				if frame.maxX > visible.maxX { frame.origin.x = max(visible.minX, visible.maxX - frame.width) }
				widening = true
				window.setFrame(frame, display: true, animate: !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
				return
			}
		}
		asideSidebar()
	}

	public var body: some View {
		@Bindable var app = app
		NavigationSplitView(columnVisibility: $columns) {
			SidebarView()
				.navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 360)
		} detail: {
			Group {
				if let session = app.session {
					SessionView(session: session)
						.id(session.id)
				} else {
					NewSessionView()
				}
			}
			.overlay(alignment: .bottom) { ToastView() }
			.overlay(alignment: .top) { ConnectionBanner() }
		}
		.frame(minWidth: smallestWidth, minHeight: 480)
		.background(WindowReader(window: $window))
		// The window's own width: the split view can't report a width below its columns' minimums.
		.onReceive(NotificationCenter.default.publisher(for: NSWindow.didResizeNotification)) { note in
			if let resized = note.object as? NSWindow, resized === window { measure(resized) }
		}
		.onChange(of: window) { _, now in if let now { measure(now) } }
		.onChange(of: workbenchOpen) { _, open in
			if open { makeRoom() }
			else if sidebarAsideForWorkbench {
				sidebarAsideForWorkbench = false
				columns = .all
			}
			updateRoom()
		}
		.onChange(of: columns) { _, now in
			// The person brought the sidebar back in a window too narrow for all three: the workbench closes.
			if now != .detailOnly {
				sidebarAsideForWorkbench = false
				if workbenchOpen, width > 0, width < roomy - 1 { app.session?.workbench.isOpen = false }
			}
			updateRoom()
		}
		.tint(Theme.accent)
		.preferredColorScheme(app.ui.theme == "light" ? .light : app.ui.theme == "dark" ? .dark : nil)
		.sheet(item: $app.joining) { request in JoinLabView(request: request) }
		.alert(
			app.confirmation?.title ?? "",
			isPresented: Binding(get: { app.confirmation != nil }, set: { if !$0 { app.confirmation = nil } }),
			presenting: app.confirmation
		) { confirmation in
			Button(confirmation.action, role: confirmation.destructive ? .destructive : nil) {
				Task { await confirmation.run() }
			}
			Button("Cancel", role: .cancel) {}
		} message: { confirmation in
			Text(confirmationMessage(confirmation))
		}
		.alert(
			deviceTitle,
			isPresented: Binding(get: { !app.deviceRequests.isEmpty }, set: { _ in }),
			presenting: app.deviceRequests.first
		) { request in
			Button("Allow") { Task { await answerDevice(request, allow: true) } }
			Button("Not Mine", role: .destructive) { Task { await answerDevice(request, allow: false) } }
			Button("Decide Later", role: .cancel) { app.deviceRequests.removeFirst() }
		} message: { request in
			Text("“\(request.name)” wants to use your sign-in at \(request.lab). Allow it only if it's a computer you just signed in on.")
		}
		.onOpenURL { url in app.openInvite(url) }
		.task {
			app.start()
			#if DEBUG
			await Automation.run(app: app, openSettings: openSettings)
			#endif
		}
	}

	private var deviceTitle: String {
		guard let request = app.deviceRequests.first else { return "" }
		return "A new device at \(request.lab)"
	}

	private func answerDevice(_ request: DeviceRequest, allow: Bool) async {
		app.deviceRequests.removeAll { $0.site == request.site && $0.id == request.id }
		do {
			if allow { try await app.connection.approveDevice(site: request.site, id: request.id) }
			else { try await app.connection.revokeDevice(site: request.site, id: request.id) }
			app.say(allow ? "Allowed “\(request.name)” at \(request.lab)." : "Revoked “\(request.name)” at \(request.lab).")
		} catch {
			app.said(error)
		}
	}

	private func confirmationMessage(_ confirmation: Confirmation) -> String {
		var lines: [String] = []
		if let detail = confirmation.detail { lines.append(detail) }
		for fact in confirmation.facts { lines.append("\(fact.label): \(fact.text)") }
		return lines.joined(separator: "\n\n")
	}
}

/// The short message at the bottom of the window.
struct ToastView: View {
	@Environment(AppModel.self) private var app

	var body: some View {
		if let toast = app.toast {
			HStack(spacing: 10) {
				Text(toast.text)
					.font(.callout)
					.lineLimit(3)
					.multilineTextAlignment(.leading)
				if let url = toast.url {
					Button("Open") { NSWorkspace.shared.open(url) }
						.buttonStyle(.borderless)
				}
				Button {
					app.toast = nil
				} label: {
					Image(systemName: "xmark").font(.caption.weight(.semibold))
				}
				.buttonStyle(.borderless)
				.foregroundStyle(.secondary)
				.accessibilityLabel("Dismiss")
			}
			.padding(.horizontal, 14)
			.padding(.vertical, 9)
			.glassEffect(.regular, in: .capsule)
			.padding(.bottom, 120)
			.frame(maxWidth: 560)
			.transition(.move(edge: .bottom).combined(with: .opacity))
			.id(toast.id)
			.accessibilityElement(children: .combine)
			.accessibilityAddTraits(.updatesFrequently)
		}
	}
}

/// Shown while the window has no engine: what is happening, in words.
struct ConnectionBanner: View {
	@Environment(AppModel.self) private var app

	var body: some View {
		switch app.connection_ {
		case .connected:
			EmptyView()
		case .connecting:
			label("Connecting to the engine…", spinning: true)
		case let .lost(reason):
			label("Reconnecting to the engine. \(reason)", spinning: true)
		}
	}

	private func label(_ text: String, spinning: Bool) -> some View {
		HStack(spacing: 8) {
			if spinning { ProgressView().controlSize(.small) }
			Text(text).font(.callout).foregroundStyle(.secondary).lineLimit(2)
		}
		.padding(.horizontal, 14)
		.padding(.vertical, 8)
		.glassEffect(.regular, in: .capsule)
		.padding(.top, 12)
	}
}

/// The NSWindow a view is in.
struct WindowReader: NSViewRepresentable {
	@Binding var window: NSWindow?

	func makeNSView(context: Context) -> NSView {
		let view = NSView()
		DispatchQueue.main.async { window = view.window }
		return view
	}

	func updateNSView(_ nsView: NSView, context: Context) {
		if window !== nsView.window { DispatchQueue.main.async { window = nsView.window } }
	}
}
