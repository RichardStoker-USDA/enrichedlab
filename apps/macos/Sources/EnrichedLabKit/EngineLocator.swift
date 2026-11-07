import Foundation

/// Finds the person's engine, or starts it with the `el` this app carries. Starting goes through `el engine ensure`,
/// so the version check, the start lock and the "a turn is running, keep it" rule live in one place: the engine.
public struct EngineLocator: Sendable {
	/// `~/.el`, or `EL_HOME`.
	public var home: URL
	/// The command that runs `el`: the app's own copy, or `EL_ENGINE_COMMAND` (such as `bun …/packages/cli/src/main.ts`) in development.
	public var command: [String]
	/// This app's version, sent in `hello` and compared with a running engine's.
	public var appVersion: String
	/// Variables the engine gets beyond the app's own (EL_HOME and EL_KEYSTORE in development).
	public var environment: [String: String]

	public init(home: URL, command: [String], appVersion: String, environment: [String: String] = [:]) {
		self.home = home
		self.command = command
		self.appVersion = appVersion
		self.environment = environment
	}

	/// The locator for this app as installed (or as started from the repository in development).
	public static func standard(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) -> EngineLocator {
		let home = environment["EL_HOME"].map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) } ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".el")
		let version = (bundle.infoDictionary?["CFBundleShortVersionString"] as? String) ?? environment["EL_APP_VERSION"] ?? "0.0.0"
		var command: [String]
		if let custom = environment["EL_ENGINE_COMMAND"], !custom.isEmpty {
			command = custom.split(separator: " ").map(String.init)
		} else if let bundled = bundle.url(forResource: "el", withExtension: nil, subdirectory: "bin") {
			command = [bundled.path]
		} else {
			command = [FileManager.default.homeDirectoryForCurrentUser.appending(path: ".local/bin/el").path]
		}
		var passed: [String: String] = [:]
		for key in ["EL_HOME", "EL_KEYSTORE"] { if let value = environment[key] { passed[key] = value } }
		return EngineLocator(home: home, command: command, appVersion: version, environment: passed)
	}

	public var engineFile: URL { home.appending(path: "run/engine.json") }

	/// The running engine, read at the moment of use (the token stays in this owner-only file).
	public func running() async -> EngineFile? {
		guard let data = try? Data(contentsOf: engineFile), let file = try? JSONDecoder().decode(EngineFile.self, from: data) else { return nil }
		guard kill(file.pid, 0) == 0 else { return nil }
		var request = URLRequest(url: URL(string: "http://127.0.0.1:\(file.port)/health")!, timeoutInterval: 1.5)
		request.setValue("Bearer \(file.token)", forHTTPHeaderField: "Authorization")
		struct Health: Decodable { var authed: Bool? }
		guard let (body, _) = try? await URLSession.shared.data(for: request), (try? JSONDecoder().decode(Health.self, from: body))?.authed == true else { return nil }
		return file
	}

	/// The engine, started if need be. An engine of another version is replaced when idle (the engine decides).
	public func ensure() async throws -> EngineFile {
		if let file = await running(), file.version == appVersion { return file }
		try await runEnsure()
		for _ in 0 ..< 50 {
			if let file = await running() { return file }
			try await Task.sleep(for: .milliseconds(100))
		}
		throw EngineError(code: -3, message: "The engine didn't start. Run “el doctor” in Terminal to see why.")
	}

	private func runEnsure() async throws {
		guard let executable = command.first else { throw EngineError(code: -3, message: "This copy of EnrichedLab has no engine.") }
		let process = Process()
		// A bare name (`bun` in development) is found on the PATH below; the app's own `el` is a full path.
		if executable.hasPrefix("/") {
			process.executableURL = URL(fileURLWithPath: executable)
			process.arguments = Array(command.dropFirst()) + ["engine", "ensure", "--json"]
		} else {
			process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
			process.arguments = command + ["engine", "ensure", "--json"]
		}
		var env = ProcessInfo.processInfo.environment
		for (key, value) in environment { env[key] = value }
		// The engine finds tools the way a login shell would; a Finder-started app has a short PATH.
		let path = env["PATH"] ?? "/usr/bin:/bin"
		let home = FileManager.default.homeDirectoryForCurrentUser
		env["PATH"] = (["/opt/homebrew/bin", "/usr/local/bin", home.appending(path: ".local/bin").path, home.appending(path: ".bun/bin").path] + [path]).joined(separator: ":")
		process.environment = env
		// What it says goes to a file, so a long message can't fill a pipe and hold the process.
		let said = FileManager.default.temporaryDirectory.appending(path: "el-ensure-\(UUID().uuidString).txt")
		FileManager.default.createFile(atPath: said.path, contents: nil)
		defer { try? FileManager.default.removeItem(at: said) }
		let errors = try FileHandle(forWritingTo: said)
		defer { try? errors.close() }
		process.standardOutput = FileHandle.nullDevice
		process.standardError = errors
		process.standardInput = FileHandle.nullDevice
		let status: Int32 = try await withCheckedThrowingContinuation { continuation in
			process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
			do {
				try process.run()
			} catch {
				process.terminationHandler = nil
				continuation.resume(throwing: EngineError(code: -3, message: "Couldn't start the engine at \(executable): \(error.localizedDescription)"))
			}
		}
		if status != 0 {
			let text = String(decoding: (try? Data(contentsOf: said)) ?? Data(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
			throw EngineError(code: -3, message: text.isEmpty ? "The engine didn't start (exit \(status))." : String(text.suffix(600)))
		}
	}
}
