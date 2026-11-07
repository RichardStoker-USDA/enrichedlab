import EnrichedLabKit
import SwiftUI

/// The main window: the sidebar (places and sessions), the session (or a new one), and the workbench beside it.
public struct RootView: View {
	@Environment(AppModel.self) private var app
	@Environment(\.openSettings) private var openSettings
	@State private var columns = NavigationSplitViewVisibility.all

	public init() {}

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
