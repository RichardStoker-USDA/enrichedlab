import AppKit
import EnrichedLabKit
import ImageIO

/// A lab desktop's screen in its live view: changed bands are drawn onto one bitmap as they arrive.
@MainActor
final class DesktopScreen {
	let width: Int
	let height: Int
	private let context: CGContext?
	/// How many bands were drawn, so each new picture has its own identity.
	private(set) var drawn = 0

	init(width: Int, height: Int, under: NSImage?) {
		self.width = max(1, width)
		self.height = max(1, height)
		context = CGContext(data: nil, width: self.width, height: self.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
		// What was shown stays until bands cover it.
		if let under, let image = under.cgImage(forProposedRect: nil, context: nil, hints: nil) {
			context?.draw(image, in: CGRect(x: 0, y: 0, width: self.width, height: self.height))
		}
	}

	/// Draw one band (the lab's x, y are from the top left). False when it didn't decode.
	func draw(_ band: DesktopBand) -> Bool {
		guard let context, let data = Data(base64Encoded: band.jpeg), let source = CGImageSourceCreateWithData(data as CFData, nil), let piece = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return false }
		context.draw(piece, in: CGRect(x: band.x, y: height - band.y - band.h, width: band.w, height: band.h))
		drawn += 1
		return true
	}

	func image() -> NSImage? {
		guard let made = context?.makeImage() else { return nil }
		return NSImage(cgImage: made, size: NSSize(width: width, height: height))
	}
}
