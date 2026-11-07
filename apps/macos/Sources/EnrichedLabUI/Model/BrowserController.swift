import AppKit
import EnrichedLabKit
import Foundation
import Observation
import WebKit

/// The window's browser pane: a WebKit view the person browses in, which the agent can also drive (open, read, click,
/// type, take a picture). The agent's scripts run in their own content world, so a page can't change what they see or
/// return. Pages read as text with numbered controls, the same as the Electron window and lab sandbox browsers
/// (page_snapshot.js comes from apps/desktop/src/page_script.mjs, and a test keeps them the same).
@MainActor
@Observable
public final class BrowserController: NSObject, WKNavigationDelegate {
	public private(set) var url: URL?
	public private(set) var title = ""
	public private(set) var loading = false
	public private(set) var canGoBack = false
	public private(set) var canGoForward = false

	@ObservationIgnored private var webView: WKWebView?
	@ObservationIgnored private let world = WKContentWorld.world(name: "enrichedlab-agent")
	@ObservationIgnored private var settled: [CheckedContinuation<Void, Never>] = []

	private static let snapshot: String = {
		guard let url = Bundle.module.url(forResource: "page_snapshot", withExtension: "js"), let text = try? String(contentsOf: url, encoding: .utf8) else { return "''" }
		return text
	}()

	/// The view the pane shows, made once per session and kept while the session is open.
	public var view: WKWebView {
		if let webView { return webView }
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = .default()
		configuration.preferences.isElementFullscreenEnabled = true
		let made = WKWebView(frame: .zero, configuration: configuration)
		made.navigationDelegate = self
		made.allowsBackForwardNavigationGestures = true
		made.allowsMagnification = true
		made.underPageBackgroundColor = .textBackgroundColor
		webView = made
		return made
	}

	public func go(_ text: String) {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else { return }
		let target: URL?
		if trimmed.contains("://") { target = URL(string: trimmed) }
		else if trimmed.contains(".") && !trimmed.contains(" ") { target = URL(string: "https://\(trimmed)") }
		else { target = URL(string: "https://duckduckgo.com/?q=\(trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? trimmed)") }
		if let target { view.load(URLRequest(url: target)) }
	}

	public func back() { webView?.goBack() }
	public func forward() { webView?.goForward() }
	public func reload() { webView?.reload() }

	// MARK: Navigation

	private func refresh() {
		url = webView?.url
		title = webView?.title ?? ""
		loading = webView?.isLoading ?? false
		canGoBack = webView?.canGoBack ?? false
		canGoForward = webView?.canGoForward ?? false
	}

	public nonisolated func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
		MainActor.assumeIsolated { refresh() }
	}

	public nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		MainActor.assumeIsolated {
			refresh()
			let waiting = settled
			settled = []
			for waiter in waiting { waiter.resume() }
		}
	}

	public nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
		MainActor.assumeIsolated {
			refresh()
			let waiting = settled
			settled = []
			for waiter in waiting { waiter.resume() }
		}
	}

	public nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
		self.webView(webView, didFail: navigation, withError: error)
	}

	/// Wait for a load to finish (at most `limit`), then a moment for scripts to draw.
	private func settle(after: Duration = .milliseconds(400), limit: Duration = .seconds(15)) async {
		if webView?.isLoading == true {
			await withCheckedContinuation { continuation in
				settled.append(continuation)
				Task { [weak self] in
					try? await Task.sleep(for: limit)
					guard let self, !self.settled.isEmpty else { return }
					let waiting = self.settled
					self.settled = []
					for waiter in waiting { waiter.resume() }
				}
			}
		}
		try? await Task.sleep(for: after)
		refresh()
	}

	// MARK: The agent's hands

	struct AgentError: LocalizedError {
		var errorDescription: String?
	}

	/// One action from the agent's browser tools. `show` brings the pane forward first.
	func agent(op: String, args: [String: JSONValue], show: () -> Void) async throws -> SurfaceAnswer {
		show()
		let page = view
		switch op {
		case "open":
			guard let text = args["url"]?.string, let target = URL(string: text), ["http", "https"].contains(target.scheme ?? "") else { throw AgentError(errorDescription: "Only http and https pages open here.") }
			page.load(URLRequest(url: target))
			await settle()
			return try await read()
		case "read":
			return try await read()
		case "click":
			guard let ref = args["ref"]?.number else { throw AgentError(errorDescription: "Say which control to click, by its number.") }
			let clicked = try await page.callAsyncJavaScript("const el = document.querySelector(`[data-agent-ref=\"${ref}\"]`); if (!el) return false; el.scrollIntoView({ block: 'center', inline: 'center' }); el.click(); return true;", arguments: ["ref": Int(ref)], contentWorld: world) as? Bool
			guard clicked == true else { throw AgentError(errorDescription: "No control \(Int(ref)) on this page now; read it again.") }
			await settle()
			return try await read()
		case "type":
			guard let ref = args["ref"]?.number else { throw AgentError(errorDescription: "Say which field to type in, by its number.") }
			let text = args["text"]?.string ?? ""
			let submit = args["submit"]?.bool ?? false
			let typed = try await page.callAsyncJavaScript(
				"""
				const el = document.querySelector(`[data-agent-ref="${ref}"]`); if (!el) return false;
				el.scrollIntoView({ block: 'center' }); el.focus();
				if ('value' in el) { const proto = Object.getPrototypeOf(el); const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; setter ? setter.call(el, text) : (el.value = text); }
				else { el.textContent = text; }
				el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
				if (submit) { const form = el.form; if (form && form.requestSubmit) form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
				return true;
				""",
				arguments: ["ref": Int(ref), "text": text, "submit": submit],
				contentWorld: world
			) as? Bool
			guard typed == true else { throw AgentError(errorDescription: "No field \(Int(ref)) on this page now; read it again.") }
			await settle(after: submit ? .milliseconds(900) : .milliseconds(200))
			return try await read()
		case "shot":
			let configuration = WKSnapshotConfiguration()
			if page.bounds.width > 1280 { configuration.snapshotWidth = 1280 }
			let image = try await page.takeSnapshot(configuration: configuration)
			guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { throw AgentError(errorDescription: "The picture didn't come out.") }
			return SurfaceAnswer(text: "\(page.title ?? "") · \(page.url?.absoluteString ?? "")", image: .init(mime: "image/png", data: png.base64EncodedString()))
		default:
			throw AgentError(errorDescription: "Unknown browser action \(op).")
		}
	}

	private func read() async throws -> SurfaceAnswer {
		let page = view
		let text = (try? await page.callAsyncJavaScript("return \(Self.snapshot)", contentWorld: world)) as? String ?? ""
		return SurfaceAnswer(text: "\(page.title?.isEmpty == false ? page.title! : "Untitled") · \(page.url?.absoluteString ?? "about:blank")\n\n\(text.isEmpty ? "(The page has no readable text; a PDF or a canvas may need browser_screenshot.)" : text)")
	}
}
