// swift-tools-version: 6.2
// The EnrichedLab app for macOS: a SwiftUI window on the same engine every surface uses (docs/architecture.md).
// EnrichedLabKit speaks the Lab protocol; EnrichedLabUI is the window; EnrichedLab is the app's entry point.

import PackageDescription

let package = Package(
	name: "EnrichedLab",
	defaultLocalization: "en",
	platforms: [.macOS(.v15)],
	products: [
		.executable(name: "EnrichedLab", targets: ["EnrichedLab"]),
		.library(name: "EnrichedLabKit", targets: ["EnrichedLabKit"]),
		.library(name: "EnrichedLabUI", targets: ["EnrichedLabUI"]),
	],
	dependencies: [
		.package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.99.3"),
		.package(url: "https://github.com/gonzalezreal/textual", exact: "0.5.0"),
	],
	targets: [
		.target(name: "EnrichedLabKit"),
		.target(
			name: "EnrichedLabUI",
			dependencies: [
				"EnrichedLabKit",
				.product(name: "SwiftTerm", package: "SwiftTerm"),
				.product(name: "Textual", package: "textual"),
			],
			resources: [.process("Resources")]
		),
		.executableTarget(name: "EnrichedLab", dependencies: ["EnrichedLabUI"]),
		.testTarget(name: "EnrichedLabKitTests", dependencies: ["EnrichedLabKit"]),
	],
	swiftLanguageModes: [.v6]
)
