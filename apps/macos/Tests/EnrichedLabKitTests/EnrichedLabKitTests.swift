import Foundation
import Testing
@testable import EnrichedLabKit

/// The repository root, from this file's place in it.
private let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

@Suite("Protocol shapes")
struct ShapeTests {
	@Test("a session snapshot decodes, kinds this app doesn't know included")
	func snapshot() throws {
		let json = """
		{"summary":{"id":"s1","cwd":"/p","title":"Plots","created":"2026-11-07T00:00:00Z","updated":"2026-11-07T00:00:00Z","model":"lab/m","turns":1,"running":false,"place":"home"},
		 "events":[
		  {"t":"header","v":1,"id":"h","at":"2026-11-07T00:00:00Z","cwd":"/p","created":"2026-11-07T00:00:00Z"},
		  {"t":"user","id":"u","at":"2026-11-07T00:00:01Z","text":"Plot it"},
		  {"t":"assistant","id":"a","at":"2026-11-07T00:00:02Z","model":"lab/m","text":"","reasoning":"thinking","toolCalls":[{"id":"c","name":"shell","args":"{}"}],"stop":"tool_use"},
		  {"t":"tool","id":"r","at":"2026-11-07T00:00:03Z","callId":"c","name":"shell","ok":true,"content":"done","view":{"verb":"ran","target":"Rscript plot.R","result":"exit 0"},"decision":"auto"},
		  {"t":"reasoning_summary","id":"rs","at":"2026-11-07T00:00:04Z","of":"a","text":"Planned the plot.","model":"lab/m"},
		  {"t":"checkpoint","id":"k","at":"2026-11-07T00:00:05Z","callId":"c","files":[]},
		  {"t":"something_new","id":"n","at":"2026-11-07T00:00:06Z","whatever":[1,2]}
		 ],
		 "status":{"sessionId":"s1","activity":"idle","model":"lab/m","context":{"used":10,"threshold":100,"window":200,"estimated":true},"queued":0},
		 "pending":[]}
		"""
		let snap = try JSONDecoder().decode(SessionSnapshot.self, from: Data(json.utf8))
		#expect(snap.events.count == 7)
		#expect(snap.events.map(\.id) == ["h", "u", "a", "r", "rs", "k", "n"])
		guard case let .assistant(step) = snap.events[2] else { Issue.record("not an assistant step"); return }
		#expect(step.toolCalls?.first?.name == "shell")
		guard case let .other(unknown) = snap.events[6] else { Issue.record("an unknown kind didn't decode as other"); return }
		#expect(unknown.t == "something_new")
		#expect(snap.status.busy == false)
	}

	@Test("free-form JSON keeps its shape")
	func json() throws {
		let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"a":[1,true,null,"x"],"b":{"c":2.5}}"#.utf8))
		#expect(value["a"]?.array?.count == 4)
		#expect(value["b"]?["c"]?.number == 2.5)
		#expect(value.text == #"{"a":[1,true,null,"x"],"b":{"c":2.5}}"#)
	}
}

@Suite("A real engine", .serialized)
struct EngineTests {
	@Test("starts through el engine ensure, then sessions open over the protocol", .timeLimit(.minutes(2)))
	func roundTrip() async throws {
		let home = FileManager.default.temporaryDirectory.appending(path: "el-kit-\(UUID().uuidString.prefix(8))")
		let project = home.appending(path: "project")
		try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: home) }
		let bun = ["/opt/homebrew/bin/bun", FileManager.default.homeDirectoryForCurrentUser.appending(path: ".bun/bin/bun").path].first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/local/bin/bun"
		let locator = EngineLocator(
			home: home.appending(path: "el"),
			command: [bun, repository.appending(path: "packages/cli/src/main.ts").path],
			appVersion: "test",
			environment: ["EL_HOME": home.appending(path: "el").path, "EL_KEYSTORE": "file"]
		)
		let connection = EngineConnection(locator: locator, client: "kit-test")
		await connection.start()
		var connected = false
		for await state in connection.states {
			if case .connected = state { connected = true; break }
			if case let .lost(reason) = state { Issue.record("lost: \(reason)"); break }
		}
		#expect(connected)
		defer { Task { await connection.stop() } }

		let made = try await connection.createSession(cwd: project.path)
		#expect(made.cwd == project.path)
		let listed = try await connection.sessions()
		#expect(listed.contains { $0.id == made.id })
		let snap = try await connection.openSession(made.id)
		#expect(snap.summary.id == made.id)
		#expect(snap.events.contains { if case .header = $0 { true } else { false } })
		let prefs = try await connection.uiPrefs()
		#expect(["auto", "light", "dark"].contains(prefs.theme))
		// The engine's own words come back as the error's message.
		await #expect(throws: EngineError.self) { try await connection.openSession("s-no-such-session") }
		try await connection.renameSessionForTest(made.id)
		let renamed = try await connection.sessions().first { $0.id == made.id }
		#expect(renamed?.title == "Kit test")

		// Stop the scratch engine.
		let stop = Process()
		stop.executableURL = URL(fileURLWithPath: bun)
		stop.arguments = [repository.appending(path: "packages/cli/src/main.ts").path, "engine", "stop"]
		stop.environment = ProcessInfo.processInfo.environment.merging(["EL_HOME": home.appending(path: "el").path], uniquingKeysWith: { _, new in new })
		try stop.run()
		stop.waitUntilExit()
	}
}

extension EngineConnection {
	func renameSessionForTest(_ id: String) async throws {
		try await rename(id, title: "Kit test")
	}
}
