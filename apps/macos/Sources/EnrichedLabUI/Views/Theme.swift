import AppKit
import EnrichedLabKit
import SwiftUI

// The window's few constants (docs/design.md): UC Davis Aggie Blue in light and Aggie Gold in dark as the accent,
// place markers in UC Davis secondary colors, system type everywhere, and a reading measure for the run sheet.

extension NSColor {
	static func dynamic(light: NSColor, dark: NSColor) -> NSColor {
		NSColor(name: nil) { appearance in
			appearance.bestMatch(from: [.darkAqua, .vibrantDark, .accessibilityHighContrastDarkAqua]) != nil ? dark : light
		}
	}

	convenience init(hex: UInt32) {
		self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
	}
}

public enum Theme {
	/// Aggie Blue #022851 in light, Aggie Gold #FFBF00 in dark.
	public static let accent = Color(nsColor: .dynamic(light: NSColor(hex: 0x022851), dark: NSColor(hex: 0xFFBF00)))
	/// Text on the accent: white on blue, Aggie Blue on gold.
	public static let onAccent = Color(nsColor: .dynamic(light: .white, dark: NSColor(hex: 0x022851)))

	/// Place markers in the order labs are listed. This computer is neutral; the color is never the only signal.
	public static func place(_ index: Int) -> Color {
		switch index {
		case 0: Color(nsColor: .tertiaryLabelColor)
		case 1: accent
		case 2: Color(nsColor: .dynamic(light: NSColor(hex: 0x266041), dark: NSColor(hex: 0x6CCA98)))
		case 3: Color(nsColor: NSColor(hex: 0x008EAA))
		default: Color(nsColor: NSColor(hex: 0x00B2E3))
		}
	}

	/// Discovery mode's mark: Aggie Gold in both appearances, with dark text on it.
	public static let discovery = Color(nsColor: .dynamic(light: NSColor(hex: 0xB07D00), dark: NSColor(hex: 0xFFBF00)))

	/// The run sheet's reading measure, about 70 characters of prose.
	public static let measure: CGFloat = 720
	public static let prose = Font.system(size: 15)
	public static let proseSpacing: CGFloat = 4.5
	public static let prompt = Font.system(size: 18, weight: .semibold)
	public static let mono = Font.system(size: 12, design: .monospaced)
	public static let small = Font.system(size: 12)
}

/// A place's marker: a small dot in its color, the name always beside it.
struct PlaceDot: View {
	var place: Place
	var size: CGFloat = 7

	var body: some View {
		Circle()
			.fill(Theme.place(place.index))
			.frame(width: size, height: size)
			.overlay {
				if place.isLocal { Circle().strokeBorder(Color(nsColor: .secondaryLabelColor), lineWidth: 1) }
			}
			.accessibilityHidden(true)
	}
}

extension View {
	/// Run sheet prose: the reading size and line spacing, selectable.
	func prose() -> some View {
		font(Theme.prose).lineSpacing(Theme.proseSpacing).textSelection(.enabled)
	}
}

/// Copy text to the clipboard, and say so.
@MainActor
func copyText(_ text: String, what: String, app: AppModel) {
	NSPasteboard.general.clearContents()
	NSPasteboard.general.setString(text, forType: .string)
	app.say("Copied \(what).")
}

/// Show a folder in Finder.
@MainActor
func revealInFinder(_ path: String) {
	NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
}

extension View {
	/// Liquid Glass on macOS 26 and later; the closest material before it, so the app runs on macOS 15 too.
	@ViewBuilder func glass(in shape: some Shape, interactive: Bool = false) -> some View {
		if #available(macOS 26, *) {
			glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
		} else {
			background(.regularMaterial, in: shape)
				.overlay(shape.stroke(.separator, lineWidth: 0.5))
		}
	}
}
