import AppKit
import EnrichedLabKit
import Foundation
import SwiftTerm

/// One terminal pane: SwiftTerm's view, wired to a terminal the engine runs where the session works (the person's
/// shell on this Mac, or a console in a lab sandbox). The view outlives tab switches; closing the tab ends it.
@MainActor
public final class TerminalSession: NSObject, TerminalViewDelegate {
	public let paneId: String
	public let view: TerminalView
	public private(set) var termId: String?
	public private(set) var label = "Terminal"
	public private(set) var ended: Int??
	private weak var connection: EngineConnection?
	private var pendingSize: (Int, Int)?
	private var sessionId: String?

	init(paneId: String) {
		self.paneId = paneId
		view = TerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
		super.init()
		view.terminalDelegate = self
		view.font = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
		view.optionAsMetaKey = true
		view.nativeBackgroundColor = .textBackgroundColor
		view.nativeForegroundColor = .textColor
		view.caretColor = .controlAccentColor
	}

	/// Start the engine's terminal once the view knows its size.
	func start(connection: EngineConnection, sessionId: String?) async throws {
		guard termId == nil else { return }
		self.connection = connection
		self.sessionId = sessionId
		let size = view.terminalDimensions
		let opened = try await connection.openTerminal(sessionId: sessionId, cols: max(20, size.cols), rows: max(5, size.rows))
		termId = opened.termId
		label = opened.label
		if let (cols, rows) = pendingSize {
			try? await connection.terminalResize(opened.termId, cols: cols, rows: rows)
		}
	}

	func output(_ data: String) {
		view.feed(text: data)
	}

	func exited(code: Int?) {
		ended = .some(code)
		view.feed(text: "\r\n\u{1b}[2m[The shell ended\(code.map { " with code \($0)" } ?? ""). Close this tab, or open a new terminal.]\u{1b}[0m\r\n")
	}

	/// The engine closes a window's terminals when its connection drops: a live one gets a new shell in the same
	/// place, now when its session is open, else when its pane shows again. One whose shell had ended stays ended.
	func restart(showing: String?) {
		guard termId != nil, ended == nil, let connection else { return }
		termId = nil
		view.feed(text: "\r\n\u{1b}[2m[Reconnected to the engine: a new shell started.]\u{1b}[0m\r\n")
		if sessionId == showing { Task { try? await start(connection: connection, sessionId: sessionId) } }
	}

	func close() {
		guard let termId, let connection else { return }
		Task { try? await connection.closeTerminal(termId) }
		self.termId = nil
	}

	// MARK: TerminalViewDelegate

	public func send(source: TerminalView, data: ArraySlice<UInt8>) {
		guard let termId, let connection, ended == nil else { return }
		let text = String(decoding: data, as: UTF8.self)
		Task { try? await connection.terminalInput(termId, text) }
	}

	public func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
		guard let termId, let connection else { pendingSize = (newCols, newRows); return }
		Task { try? await connection.terminalResize(termId, cols: newCols, rows: newRows) }
	}

	public func setTerminalTitle(source: TerminalView, title: String) {}
	public func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
	public func scrolled(source: TerminalView, position: Double) {}
	public func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

	public func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
		if let url = URL(string: link), ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
	}

	public func clipboardCopy(source: TerminalView, content: Data) {
		guard let text = String(data: content, encoding: .utf8) else { return }
		NSPasteboard.general.clearContents()
		NSPasteboard.general.setString(text, forType: .string)
	}
}

/// Every terminal the window has open, by pane, so output reaches the right view.
@MainActor
public final class TerminalHub {
	private var sessions: [String: TerminalSession] = [:]

	func session(for paneId: String) -> TerminalSession {
		if let open = sessions[paneId] { return open }
		let made = TerminalSession(paneId: paneId)
		sessions[paneId] = made
		return made
	}

	func output(_ termId: String, _ data: String) {
		sessions.values.first { $0.termId == termId }?.output(data)
	}

	func exited(_ termId: String, code: Int?) {
		sessions.values.first { $0.termId == termId }?.exited(code: code)
	}

	func restartAll(showing: String?) {
		for session in sessions.values { session.restart(showing: showing) }
	}

	func close(paneId: String) {
		sessions.removeValue(forKey: paneId)?.close()
	}
}

/// A picture sent as base64 (PNG or JPEG).
func decodeImage(_ base64: String) -> NSImage? {
	Data(base64Encoded: base64).flatMap(NSImage.init(data:))
}
