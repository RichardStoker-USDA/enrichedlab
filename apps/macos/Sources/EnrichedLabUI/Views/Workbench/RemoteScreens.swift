import AppKit
import EnrichedLabKit
import SwiftUI

// MARK: The canvas

/// Input on a remote screen, in the screen's own pixels.
enum RemoteInput {
	case click(x: Int, y: Int, button: String, count: Int)
	case drag(from: (Int, Int), to: (Int, Int))
	case press(x: Int, y: Int, button: String, down: Bool, count: Int)
	case move(x: Int, y: Int)
	case scroll(x: Int, y: Int, dx: Double, dy: Double)
	case text(String)
	case key(String, down: Bool)
}

/// Draws the newest picture of a remote screen to fit, and turns the person's clicks, drags, scrolls and keys into
/// input in that screen's pixels. Keys the app owns (⌘Q, ⌘W, ⌘,) stay with the app.
final class RemoteCanvas: NSView {
	var image: NSImage? { didSet { needsDisplay = true } }
	var screenSize = CGSize(width: 1280, height: 800) { didSet { needsDisplay = true } }
	/// Desktop mode sends whole clicks and drags; browser mode sends raw presses and moves.
	var raw = false
	var onInput: ((RemoteInput) -> Void)?

	override var acceptsFirstResponder: Bool { true }
	override var isFlipped: Bool { true }

	override func draw(_ dirtyRect: NSRect) {
		NSColor.underPageBackgroundColor.setFill()
		bounds.fill()
		guard let image else { return }
		image.draw(in: fitted, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
	}

	/// Where the picture sits: aspect-fit and centered.
	private var fitted: CGRect {
		guard screenSize.width > 0, screenSize.height > 0 else { return bounds }
		let scale = min(bounds.width / screenSize.width, bounds.height / screenSize.height)
		let size = CGSize(width: screenSize.width * scale, height: screenSize.height * scale)
		return CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
	}

	private func point(_ event: NSEvent) -> (Int, Int)? {
		let local = convert(event.locationInWindow, from: nil)
		let box = fitted
		guard box.contains(local), box.width > 0 else { return nil }
		let x = (local.x - box.minX) / box.width * screenSize.width
		let y = (local.y - box.minY) / box.height * screenSize.height
		return (min(Int(screenSize.width) - 1, max(0, Int(x))), min(Int(screenSize.height) - 1, max(0, Int(y))))
	}

	// MARK: Mouse

	private var downAt: (Int, Int)?
	private var dragged = false
	private var pendingClick: DispatchWorkItem?

	override func mouseDown(with event: NSEvent) {
		window?.makeFirstResponder(self)
		guard let at = point(event) else { return }
		if raw { onInput?(.press(x: at.0, y: at.1, button: "left", down: true, count: event.clickCount)); return }
		downAt = at
		dragged = false
	}

	override func mouseDragged(with event: NSEvent) {
		guard let at = point(event) else { return }
		if raw { onInput?(.move(x: at.0, y: at.1)); return }
		if let start = downAt, abs(at.0 - start.0) + abs(at.1 - start.1) > 4 { dragged = true }
	}

	override func mouseUp(with event: NSEvent) {
		guard let at = point(event) else { return }
		if raw { onInput?(.press(x: at.0, y: at.1, button: "left", down: false, count: event.clickCount)); return }
		defer { downAt = nil }
		if dragged, let start = downAt {
			onInput?(.drag(from: start, to: at))
			return
		}
		// A single click waits a moment, so a double or triple click is sent as one action, not as several.
		pendingClick?.cancel()
		let count = event.clickCount
		if count >= 2 {
			onInput?(.click(x: at.0, y: at.1, button: "left", count: min(count, 3)))
			return
		}
		let work = DispatchWorkItem { [weak self] in self?.onInput?(.click(x: at.0, y: at.1, button: "left", count: 1)) }
		pendingClick = work
		DispatchQueue.main.asyncAfter(deadline: .now() + NSEvent.doubleClickInterval * 0.6, execute: work)
	}

	override func rightMouseDown(with event: NSEvent) {
		guard let at = point(event) else { return }
		onInput?(raw ? .press(x: at.0, y: at.1, button: "right", down: true, count: 1) : .click(x: at.0, y: at.1, button: "right", count: 1))
	}

	override func rightMouseUp(with event: NSEvent) {
		guard raw, let at = point(event) else { return }
		onInput?(.press(x: at.0, y: at.1, button: "right", down: false, count: 1))
	}

	override func otherMouseDown(with event: NSEvent) {
		guard let at = point(event) else { return }
		onInput?(raw ? .press(x: at.0, y: at.1, button: "middle", down: true, count: 1) : .click(x: at.0, y: at.1, button: "middle", count: 1))
	}

	override func mouseMoved(with event: NSEvent) {
		guard raw, let at = point(event) else { return }
		onInput?(.move(x: at.0, y: at.1))
	}

	private var scrollX = 0.0, scrollY = 0.0
	private var scrollAt: (Int, Int)?
	private var scrollFlush: DispatchWorkItem?

	override func scrollWheel(with event: NSEvent) {
		guard let at = point(event) else { return }
		scrollX += event.scrollingDeltaX
		scrollY += event.scrollingDeltaY
		scrollAt = at
		guard scrollFlush == nil else { return }
		let work = DispatchWorkItem { [weak self] in
			guard let self, let at = self.scrollAt else { return }
			self.onInput?(.scroll(x: at.0, y: at.1, dx: self.scrollX, dy: self.scrollY))
			self.scrollX = 0
			self.scrollY = 0
			self.scrollFlush = nil
		}
		scrollFlush = work
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
	}

	override func updateTrackingAreas() {
		super.updateTrackingAreas()
		trackingAreas.forEach(removeTrackingArea)
		if raw { addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)) }
	}

	// MARK: Keys

	private var typed = ""
	private var typeFlush: DispatchWorkItem?

	override func performKeyEquivalent(with event: NSEvent) -> Bool {
		guard window?.firstResponder === self else { return false }
		let command = event.modifierFlags.contains(.command)
		let letters = event.charactersIgnoringModifiers?.lowercased() ?? ""
		// The app's own: quit, close, settings, hide, minimize, the workbench and sidebar toggles.
		if command, ["q", "w", ",", "h", "m", "n"].contains(letters) { return false }
		if command, letters == "v", let text = NSPasteboard.general.string(forType: .string) {
			flushTyping()
			onInput?(.text(String(text.prefix(4000))))
			return true
		}
		if command, !letters.isEmpty {
			// ⌘ on the Mac is Ctrl on the remote screen: ⌘C copies there, ⌘A selects all there.
			onInput?(.key("ctrl+\(letters)", down: true))
			return true
		}
		return false
	}

	override func keyDown(with event: NSEvent) {
		if let name = Self.keyName(event) {
			flushTyping()
			let mods = event.modifierFlags
			var chord: [String] = []
			if mods.contains(.control) { chord.append("ctrl") }
			if mods.contains(.option) { chord.append("alt") }
			if mods.contains(.shift), name.count > 1 { chord.append("shift") }
			chord.append(name)
			onInput?(.key(chord.joined(separator: "+"), down: true))
			if raw { onInput?(.key(chord.joined(separator: "+"), down: false)) }
			return
		}
		if event.modifierFlags.contains(.control), let letter = event.charactersIgnoringModifiers?.lowercased(), !letter.isEmpty {
			onInput?(.key("ctrl+\(letter)", down: true))
			return
		}
		guard let characters = event.characters, !characters.isEmpty else { return }
		// Typing is sent in short bursts, not a key at a time.
		typed += characters
		typeFlush?.cancel()
		let work = DispatchWorkItem { [weak self] in self?.flushTyping() }
		typeFlush = work
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
	}

	private func flushTyping() {
		typeFlush?.cancel()
		typeFlush = nil
		guard !typed.isEmpty else { return }
		onInput?(.text(typed))
		typed = ""
	}

	/// The xdotool name of a special key, or nil for text.
	static func keyName(_ event: NSEvent) -> String? {
		switch event.keyCode {
		case 36, 76: "Return"
		case 48: "Tab"
		case 51: "BackSpace"
		case 117: "Delete"
		case 53: "Escape"
		case 123: "Left"
		case 124: "Right"
		case 125: "Down"
		case 126: "Up"
		case 115: "Home"
		case 119: "End"
		case 116: "Page_Up"
		case 121: "Page_Down"
		case 122: "F1"
		case 120: "F2"
		case 99: "F3"
		case 118: "F4"
		case 96: "F5"
		case 97: "F6"
		case 98: "F7"
		case 100: "F8"
		case 101: "F9"
		case 109: "F10"
		case 103: "F11"
		case 111: "F12"
		default: nil
		}
	}
}

private struct CanvasHost: NSViewRepresentable {
	var image: NSImage?
	var size: CGSize
	var raw: Bool
	var onInput: (RemoteInput) -> Void

	func makeNSView(context: Context) -> RemoteCanvas {
		let canvas = RemoteCanvas()
		canvas.raw = raw
		return canvas
	}

	func updateNSView(_ canvas: RemoteCanvas, context: Context) {
		canvas.image = image
		canvas.screenSize = size
		canvas.onInput = onInput
	}
}

// MARK: A lab's desktop

/// A lab's desktop sandbox, which the person and the agent both use. Every action goes through the lab's checked
/// endpoint, marked as the person's; the picture comes back a moment after.
struct DesktopPane: View {
	@Environment(AppModel.self) private var app
	var site: String
	var session: SessionModel
	@State private var target = ""
	@State private var settle: Task<Void, Never>?

	private var canOpen: Bool { app.sites.first(where: { $0.name == site })?.desktop?.open == true }

	@ViewBuilder private func title(_ frame: DesktopFrame?) -> some View {
		PlaceDot(place: app.place(of: site))
		Text("\(app.place(of: site).title) desktop").font(.callout).lineLimit(1).fixedSize()
		if let frame, frame.by == "agent" {
			Text("The agent is using it").font(.caption).foregroundStyle(Theme.accent).lineLimit(1).fixedSize()
		}
		Spacer(minLength: 8)
	}

	@ViewBuilder private func tools(_ frame: DesktopFrame?) -> some View {
		if let frame { Text("\(frame.width) × \(frame.height)").font(.caption).foregroundStyle(.secondary).monospacedDigit().fixedSize() }
		Button { Task { await app.desktopAct(site: site, action: ["action": "screenshot"]) } } label: { Image(systemName: "arrow.clockwise") }
			.buttonStyle(.borderless)
			.help("Refresh the picture")
	}

	private var addressField: some View {
		TextField("Open an address or a /sandbox file", text: $target)
			.textFieldStyle(.roundedBorder)
			.onSubmit {
				let value = target.trimmingCharacters(in: .whitespaces)
				guard !value.isEmpty else { return }
				target = ""
				Task {
					await app.desktopOpen(site: site, target: value)
					settleShot(after: 1.5)
				}
			}
	}

	var body: some View {
		let frame = app.desktops[site]
		VStack(spacing: 0) {
			// One row when the pane is wide enough; the address field takes its own row when it isn't.
			ViewThatFits(in: .horizontal) {
				HStack(spacing: 8) {
					title(frame)
					if canOpen { addressField.frame(minWidth: 200, idealWidth: 260, maxWidth: 280) }
					tools(frame)
				}
				VStack(spacing: 6) {
					HStack(spacing: 8) {
						title(frame)
						tools(frame)
					}
					if canOpen { addressField }
				}
			}
			.padding(.horizontal, 12)
			.padding(.vertical, 6)
			.overlay(alignment: .bottom) {
				if app.desktopBusy.contains(site) { ProgressView().progressViewStyle(.linear).controlSize(.mini).tint(Theme.accent) }
			}
			Divider()
			if let frame, let image = app.desktopImages[site]?.image {
				CanvasHost(image: image, size: CGSize(width: frame.width, height: frame.height), raw: false) { input in act(input) }
			} else {
				ContentUnavailableView {
					Label("Desktop", systemImage: "display")
				} description: {
					Text("A Linux desktop in the \(app.place(of: site).title) sandbox. You and the agent both use it; the lab records each action.")
				} actions: {
					Button("Start Desktop") { Task { await app.desktopAct(site: site, action: ["action": "screenshot"]) } }
						.buttonStyle(.borderedProminent)
						.disabled(app.desktopBusy.contains(site))
				}
			}
		}
		.task(id: site) {
			if app.desktops[site] == nil { await app.desktopAct(site: site, action: ["action": "screenshot"]) }
		}
	}

	private func act(_ input: RemoteInput) {
		var action: [String: JSONValue]
		switch input {
		case let .click(x, y, button, count):
			let name = button == "right" ? "right_click" : button == "middle" ? "middle_click" : count == 2 ? "double_click" : count == 3 ? "triple_click" : "left_click"
			action = ["action": .string(name), "coordinate": [.number(Double(x)), .number(Double(y))]]
		case let .drag(from, to):
			action = ["action": "left_click_drag", "start_coordinate": [.number(Double(from.0)), .number(Double(from.1))], "coordinate": [.number(Double(to.0)), .number(Double(to.1))]]
		case let .scroll(x, y, dx, dy):
			let vertical = abs(dy) >= abs(dx)
			let amount = max(1, min(10, Int((abs(vertical ? dy : dx) / 12).rounded())))
			action = ["action": "scroll", "coordinate": [.number(Double(x)), .number(Double(y))], "scroll_direction": .string(vertical ? (dy > 0 ? "up" : "down") : (dx > 0 ? "left" : "right")), "scroll_amount": .number(Double(amount))]
		case let .text(text):
			action = ["action": "type", "text": .string(text)]
		case let .key(name, _):
			action = ["action": "key", "text": .string(name)]
		case .press, .move:
			return
		}
		Task {
			await app.desktopAct(site: site, action: action)
			settleShot(after: 0.5)
		}
	}

	/// The lab answers input without a picture: one a moment after the last input shows what it did.
	private func settleShot(after seconds: Double) {
		settle?.cancel()
		settle = Task {
			try? await Task.sleep(for: .seconds(seconds))
			guard !Task.isCancelled else { return }
			await app.desktopAct(site: site, action: ["action": "screenshot"])
		}
	}
}

// MARK: A lab sandbox's browser

/// The agent's page in a lab sandbox's browser, shown live while the pane is open. The person can browse it too.
struct ScreenPane: View {
	@Environment(AppModel.self) private var app
	var site: String
	var session: SessionModel
	@State private var address = ""

	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 8) {
				Button { navigate(step: "back") } label: { Image(systemName: "chevron.left") }.disabled(session.screen?.canBack != true)
				Button { navigate(step: "forward") } label: { Image(systemName: "chevron.right") }.disabled(session.screen?.canForward != true)
				Button { navigate(step: "reload") } label: { Image(systemName: "arrow.clockwise") }
				TextField("Address", text: $address)
					.textFieldStyle(.roundedBorder)
					.onSubmit { navigate(url: address) }
				PlaceDot(place: app.place(of: site))
			}
			.buttonStyle(.borderless)
			.padding(.horizontal, 10)
			.padding(.vertical, 6)
			Divider()
			GeometryReader { geometry in
				Group {
					if let frame = session.screenFrame, let image = session.screenImage {
						CanvasHost(image: image, size: CGSize(width: frame.width, height: frame.height), raw: true) { input in send(input) }
					} else {
						ContentUnavailableView("Waiting for the Page", systemImage: "globe", description: Text("The agent's browser in the \(app.place(of: site).title) sandbox shows here."))
					}
				}
				.task(id: "\(Int(geometry.size.width))x\(Int(geometry.size.height))") {
					try? await Task.sleep(for: .milliseconds(200))
					try? await app.connection.send("browser.resize", BrowserSize(sessionId: session.id, width: Int(geometry.size.width), height: Int(geometry.size.height)))
				}
			}
		}
		.onAppear { address = session.screen?.url ?? "" }
		.onChange(of: session.screen?.url) { _, url in address = url ?? "" }
		.task {
			if let page = try? await app.connection.watchBrowser(sessionId: session.id, on: true) { session.screen = page }
		}
		.onDisappear { Task { _ = try? await app.connection.watchBrowser(sessionId: session.id, on: false) } }
	}

	private struct BrowserSize: Encodable, Sendable { var sessionId: String; var width: Int; var height: Int }
	private struct Navigate: Encodable, Sendable { var sessionId: String; var site: String; var url: String?; var step: String? }
	private struct Input: Encodable, Sendable { var sessionId: String; var event: [String: JSONValue] }

	private func navigate(url: String? = nil, step: String? = nil) {
		Task {
			do { try await app.connection.send("browser.navigate", Navigate(sessionId: session.id, site: site, url: url, step: step)) } catch { app.said(error) }
		}
	}

	private func send(_ input: RemoteInput) {
		var event: [String: JSONValue]
		switch input {
		case let .press(x, y, button, down, count):
			event = ["kind": "mouse", "type": .string(down ? "mousePressed" : "mouseReleased"), "x": .number(Double(x)), "y": .number(Double(y)), "button": .string(button), "clickCount": .number(Double(count))]
		case let .move(x, y):
			event = ["kind": "mouse", "type": "mouseMoved", "x": .number(Double(x)), "y": .number(Double(y)), "button": "none"]
		case let .scroll(x, y, dx, dy):
			event = ["kind": "wheel", "x": .number(Double(x)), "y": .number(Double(y)), "deltaX": .number(-dx * 2), "deltaY": .number(-dy * 2)]
		case let .text(text):
			event = ["kind": "text", "text": .string(text)]
		case let .key(name, down):
			let key = name.split(separator: "+").last.map(String.init) ?? name
			let web = ["Return": "Enter", "BackSpace": "Backspace", "Page_Up": "PageUp", "Page_Down": "PageDown", "Left": "ArrowLeft", "Right": "ArrowRight", "Up": "ArrowUp", "Down": "ArrowDown"][key] ?? key
			let mods = (name.contains("alt+") ? 1 : 0) | (name.contains("ctrl+") ? 2 : 0) | (name.contains("shift+") ? 8 : 0)
			event = ["kind": "key", "type": .string(down ? "keyDown" : "keyUp"), "key": .string(web), "modifiers": .number(Double(mods))]
		case .click, .drag:
			return
		}
		Task { try? await app.connection.send("browser.input", Input(sessionId: session.id, event: event)) }
	}
}
