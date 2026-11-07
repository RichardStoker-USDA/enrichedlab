import AppKit
import EnrichedLabKit
import SwiftTerm
import SwiftUI
import UniformTypeIdentifiers
import WebKit

// MARK: Files

/// The folder where the session works (this Mac or a lab sandbox). Open a file to see it as a table, figure or page.
struct FilesPane: View {
	@Environment(AppModel.self) private var app
	var session: SessionModel
	@State private var path = ""
	@State private var listing: DirectoryListing?
	@State private var error: String?
	@State private var selection: String?

	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 4) {
				Button { go("") } label: { Text(listing.map { folderName($0.root) } ?? "Project") }
					.buttonStyle(.borderless)
				ForEach(Array(crumbs.enumerated()), id: \.offset) { i, part in
					Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
					Button(part) { go(crumbs.prefix(i + 1).joined(separator: "/")) }.buttonStyle(.borderless)
				}
				Spacer()
				Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
					.buttonStyle(.borderless)
					.help("Refresh")
			}
			.font(.callout)
			.padding(.horizontal, 12)
			.padding(.vertical, 7)
			Divider()
			if let error {
				ContentUnavailableView("Can't Show This Folder", systemImage: "folder.badge.questionmark", description: Text(error))
			} else if let listing {
				List(selection: $selection) {
					ForEach(sorted(listing.entries)) { entry in
						HStack(spacing: 8) {
							Image(systemName: entry.type == "dir" ? "folder.fill" : icon(entry.name))
								.foregroundStyle(entry.type == "dir" ? Theme.accent : .secondary)
								.frame(width: 16)
							Text(entry.name).lineLimit(1)
							Spacer()
							if entry.type != "dir" { Text(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file)).font(.caption).foregroundStyle(.secondary).monospacedDigit() }
						}
						.tag(entry.name)
						.contextMenu { menu(entry) }
					}
				}
				.listStyle(.inset)
				.contextMenu(forSelectionType: String.self) { _ in } primaryAction: { names in
					if let name = names.first, let entry = listing.entries.first(where: { $0.name == name }) { open(entry) }
				}
				.overlay { if listing.entries.isEmpty { Text("Empty folder").foregroundStyle(.secondary) } }
			} else {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			}
		}
		.task(id: "\(session.place.id):\(path)") { await load() }
	}

	private var crumbs: [String] { path.split(separator: "/").map(String.init) }

	private func full(_ name: String) -> String { path.isEmpty ? name : "\(path)/\(name)" }

	private func go(_ next: String) {
		path = next
		selection = nil
	}

	private func load() async {
		do {
			listing = try await app.connection.listFiles(sessionId: session.id, path: path.isEmpty ? nil : path)
			error = nil
		} catch let failure {
			error = (failure as? LocalizedError)?.errorDescription ?? failure.localizedDescription
		}
	}

	private func open(_ entry: DirectoryEntry) {
		if entry.type == "dir" { go(full(entry.name)) } else { Task { await session.openFile(full(entry.name)) } }
	}

	private func sorted(_ entries: [DirectoryEntry]) -> [DirectoryEntry] {
		entries.sorted { a, b in
			if (a.type == "dir") != (b.type == "dir") { return a.type == "dir" }
			return a.name.localizedStandardCompare(b.name) == .orderedAscending
		}
	}

	private func icon(_ name: String) -> String {
		switch (name as NSString).pathExtension.lowercased() {
		case "csv", "tsv", "parquet", "xlsx": "tablecells"
		case "png", "jpg", "jpeg", "gif", "svg", "webp", "tif", "tiff": "photo"
		case "pdf": "doc.richtext"
		case "r", "py", "js", "ts", "swift", "sh", "sql": "chevron.left.forwardslash.chevron.right"
		case "md", "txt": "doc.text"
		case "html": "globe"
		default: "doc"
		}
	}

	@ViewBuilder private func menu(_ entry: DirectoryEntry) -> some View {
		Button(entry.type == "dir" ? "Open Folder" : "Open") { open(entry) }
		Button("Copy Path") { copyText(full(entry.name), what: "the path", app: app) }
		if session.place.isLocal, let root = listing?.root {
			Button("Show in Finder") { revealInFinder(URL(fileURLWithPath: root).appending(path: full(entry.name)).path) }
		}
	}
}

// MARK: Terminal

/// A terminal where the session works: the person's shell on this Mac, or a console in the lab sandbox.
struct TerminalPane: View {
	@Environment(AppModel.self) private var app
	@Environment(\.colorScheme) private var scheme
	var paneId: String
	var session: SessionModel
	@State private var error: String?

	var body: some View {
		let terminal = app.terminalHub.session(for: paneId)
		TerminalHost(view: terminal.view)
			.padding(.leading, 8)
			.padding(.top, 6)
			.background(scheme == .dark ? Color(red: 0.09, green: 0.09, blue: 0.10) : .white)
			.overlay {
				if let error { ContentUnavailableView("The Terminal Didn't Start", systemImage: "terminal", description: Text(error)) }
			}
			.task {
				do {
					try await terminal.start(connection: app.connection, sessionId: session.id)
					terminal.view.window?.makeFirstResponder(terminal.view)
				} catch let failure {
					error = (failure as? LocalizedError)?.errorDescription ?? failure.localizedDescription
				}
			}
	}
}

private struct TerminalHost: NSViewRepresentable {
	var view: TerminalView
	@Environment(\.colorScheme) private var scheme

	func makeNSView(context: Context) -> TerminalView { view }

	/// The terminal follows the window's appearance: resolved colors, set again when it changes.
	func updateNSView(_ nsView: TerminalView, context: Context) {
		let dark = scheme == .dark
		nsView.nativeBackgroundColor = dark ? NSColor(srgbRed: 0.09, green: 0.09, blue: 0.10, alpha: 1) : .white
		nsView.nativeForegroundColor = dark ? NSColor(srgbRed: 0.90, green: 0.90, blue: 0.92, alpha: 1) : NSColor(srgbRed: 0.11, green: 0.11, blue: 0.12, alpha: 1)
	}
}

// MARK: Web pages (views, running apps)

/// A page the engine serves (an agent-made view) or a running app. Export a figure as PDF or a high-resolution PNG.
struct WebPane: View {
	@Environment(AppModel.self) private var app
	var url: URL
	var title: String
	var toolbar = true
	@State private var web = WebHolder()

	var body: some View {
		VStack(spacing: 0) {
			if toolbar {
				HStack(spacing: 10) {
					Text(title).font(.callout).foregroundStyle(.secondary).lineLimit(1)
					Spacer()
					Button { web.view.reload() } label: { Image(systemName: "arrow.clockwise") }.help("Reload")
					Menu {
						Button("Export Figure as PDF…") { Task { await export(pdf: true) } }
						Button("Export Figure as PNG (2×)…") { Task { await export(pdf: false, scale: 2) } }
						Button("Export Figure as PNG (3×)…") { Task { await export(pdf: false, scale: 3) } }
						Divider()
						Button("Open in Browser") { NSWorkspace.shared.open(web.view.url ?? url) }
					} label: {
						Image(systemName: "square.and.arrow.up")
					}
					.menuStyle(.button)
					.menuIndicator(.hidden)
					.fixedSize()
					.help("Export or open")
				}
				.buttonStyle(.borderless)
				.padding(.horizontal, 12)
				.padding(.vertical, 6)
				Divider()
			}
			WebHost(view: web.view)
				.task(id: url) { web.view.load(URLRequest(url: url)) }
		}
	}

	private func export(pdf: Bool, scale: CGFloat = 2) async {
		let panel = NSSavePanel()
		panel.nameFieldStringValue = "\(title.isEmpty ? "figure" : title).\(pdf ? "pdf" : "png")"
		panel.allowedContentTypes = [pdf ? .pdf : .png]
		guard panel.runModal() == .OK, let target = panel.url else { return }
		do {
			let data = try await web.view.pdf(configuration: WKPDFConfiguration())
			if pdf {
				try data.write(to: target)
			} else {
				try pngFromPDF(data, scale: scale).write(to: target)
			}
			app.say("Saved \(target.lastPathComponent).")
		} catch {
			app.said(error, prefix: "The figure didn't save")
		}
	}
}

/// Render the first page of a PDF to PNG at a scale: vector content stays sharp at print sizes.
func pngFromPDF(_ data: Data, scale: CGFloat) throws -> Data {
	struct Failed: LocalizedError { var errorDescription: String? { "The page couldn't be drawn." } }
	guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider), let page = document.page(at: 1) else { throw Failed() }
	let box = page.getBoxRect(.mediaBox)
	let width = Int(box.width * scale), height = Int(box.height * scale)
	guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failed() }
	context.setFillColor(CGColor.white)
	context.fill(CGRect(x: 0, y: 0, width: width, height: height))
	context.scaleBy(x: scale, y: scale)
	context.drawPDFPage(page)
	guard let image = context.makeImage() else { throw Failed() }
	let bitmap = NSBitmapImageRep(cgImage: image)
	bitmap.size = NSSize(width: box.width, height: box.height)
	guard let png = bitmap.representation(using: .png, properties: [:]) else { throw Failed() }
	return png
}

/// A web view made once per pane, when it first shows (SwiftUI may make this holder more than once).
@MainActor
final class WebHolder {
	lazy var view: WKWebView = {
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .default()
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.allowsMagnification = true
		view.underPageBackgroundColor = .textBackgroundColor
		return view
	}()
}

struct WebHost: NSViewRepresentable {
	var view: WKWebView
	func makeNSView(context: Context) -> WKWebView { view }
	func updateNSView(_ nsView: WKWebView, context: Context) {}
}

// MARK: Browser

/// The window's own browser: the person browses here, and the agent's browser tools act on the same page.
struct BrowserPane: View {
	@Bindable var browser: BrowserController
	@State private var address = ""
	@FocusState private var editing: Bool

	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 8) {
				Button { browser.back() } label: { Image(systemName: "chevron.left") }.disabled(!browser.canGoBack).help("Back")
				Button { browser.forward() } label: { Image(systemName: "chevron.right") }.disabled(!browser.canGoForward).help("Forward")
				Button { browser.reload() } label: { Image(systemName: browser.loading ? "xmark" : "arrow.clockwise") }.help("Reload")
				TextField("Search or enter an address", text: $address)
					.textFieldStyle(.roundedBorder)
					.focused($editing)
					.onSubmit { browser.go(address) }
			}
			.buttonStyle(.borderless)
			.padding(.horizontal, 10)
			.padding(.vertical, 6)
			Divider()
			WebHost(view: browser.view)
				.overlay {
					if browser.url == nil {
						Text("The agent's browser and yours. Your sign-ins stay on this Mac.")
							.foregroundStyle(.secondary)
							.padding()
					}
				}
		}
		.onChange(of: browser.url) { _, url in if !editing { address = url?.absoluteString ?? "" } }
		.onAppear { address = browser.url?.absoluteString ?? "" }
	}
}

// MARK: Apps

/// An app (MCP Apps) in the workbench. Its page runs in the engine-served web pane, which carries the same bridge and
/// consent as every other window, so an app behaves the same here, in the browser and on Windows.
struct AppPane: View {
	@Environment(AppModel.self) private var app
	@Environment(\.colorScheme) private var scheme
	var appId: String
	var session: SessionModel
	@State private var web = WebHolder()
	@State private var error: String?

	var body: some View {
		WebHost(view: web.view)
			.overlay {
				if let error { ContentUnavailableView("The App Didn't Open", systemImage: "app.dashed", description: Text(error)) }
			}
			.task(id: "\(appId):\(scheme == .dark ? "dark" : "light")") {
				let next = "/#/embed/app/\(appId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? appId)?session=\(session.id)&theme=\(scheme == .dark ? "dark" : "light")"
				do {
					guard let link = try await app.connection.pairLink(next: next) else { throw EngineError(code: -1, message: "The engine gave no address for the app.") }
					web.view.load(URLRequest(url: link))
					error = nil
				} catch let failure {
					error = (failure as? LocalizedError)?.errorDescription ?? failure.localizedDescription
				}
			}
	}
}
