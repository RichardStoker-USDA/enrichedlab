import Foundation

/// An error the engine answered with, or a connection that failed. `message` is written for people.
public struct EngineError: Error, LocalizedError, Sendable, Hashable {
	public var code: Int
	public var message: String

	public init(code: Int, message: String) {
		self.code = code
		self.message = message
	}

	public var errorDescription: String? { message }

	public static let lost = EngineError(code: -1, message: "The connection to the engine was lost.")
	public static let notConnected = EngineError(code: -2, message: "Not connected to the engine yet.")
}

/// A notification from the engine: its method and the raw JSON of its params, decoded by whoever handles it.
public struct EngineNotification: Sendable {
	public var method: String
	public var params: Data

	public func decode<T: Decodable>(_ type: T.Type) throws -> T {
		try JSONDecoder().decode(type, from: params)
	}
}

/// Whether the window is connected, for the toolbar and the reconnect notice.
public enum ConnectionState: Sendable, Hashable {
	case connecting
	case connected(engine: String, reconnected: Bool)
	case lost(String)
}

/// The Lab protocol client: JSON-RPC 2.0 over the engine's loopback WebSocket, with the engine's bearer token. It finds
/// (or starts) the engine through `EngineLocator`, reconnects on its own when the engine restarts, and hands
/// notifications to one consumer as an async stream.
public actor EngineConnection {
	private let locator: EngineLocator
	private let client: String
	private let capabilities: [String]
	private var task: URLSessionWebSocketTask?
	private let session: URLSession
	private var nextId = 1
	private var waiting: [Int: CheckedContinuation<Data, any Error>] = [:]
	private var attempt = 0
	private var started = false

	public nonisolated let notifications: AsyncStream<EngineNotification>
	private let notify: AsyncStream<EngineNotification>.Continuation
	public nonisolated let states: AsyncStream<ConnectionState>
	private let stateOut: AsyncStream<ConnectionState>.Continuation

	public init(locator: EngineLocator, client: String = "macos", capabilities: [String] = []) {
		self.locator = locator
		self.client = client
		self.capabilities = capabilities
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = 60 * 60
		configuration.waitsForConnectivity = false
		session = URLSession(configuration: configuration)
		(notifications, notify) = AsyncStream.makeStream(bufferingPolicy: .unbounded)
		(states, stateOut) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(8))
	}

	/// Connect, and keep reconnecting after a loss until `stop()`.
	public func start() {
		guard !started else { return }
		started = true
		Task { await self.connect() }
	}

	public func stop() {
		started = false
		task?.cancel(with: .goingAway, reason: nil)
		task = nil
		failAll(.lost)
	}

	private func connect() async {
		guard started else { return }
		stateOut.yield(.connecting)
		do {
			let file = try await locator.ensure()
			var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(file.port)/rpc")!)
			request.setValue("Bearer \(file.token)", forHTTPHeaderField: "Authorization")
			let socket = session.webSocketTask(with: request)
			socket.maximumMessageSize = 64 * 1024 * 1024
			task = socket
			socket.resume()
			let reconnected = attempt > 0
			Task { await self.receive(on: socket) }
			struct Hello: Encodable { var client: String; var version: String; var capabilities: [String] }
			struct HelloResult: Decodable { var engine: String; var `protocol`: Int }
			let hello: HelloResult = try await call("hello", Hello(client: client, version: locator.appVersion, capabilities: capabilities))
			attempt = 0
			stateOut.yield(.connected(engine: hello.engine, reconnected: reconnected))
		} catch {
			await lost((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
		}
	}

	private func receive(on socket: URLSessionWebSocketTask) async {
		while true {
			let message: URLSessionWebSocketTask.Message
			do {
				message = try await socket.receive()
			} catch {
				if socket === task { await lost("The connection to the engine closed.") }
				return
			}
			let data: Data
			switch message {
			case let .string(text): data = Data(text.utf8)
			case let .data(bytes): data = bytes
			@unknown default: continue
			}
			handle(data)
		}
	}

	private struct Envelope: Decodable {
		struct Failure: Decodable { var code: Int; var message: String }
		var id: Int?
		var method: String?
		var error: Failure?
	}

	private struct ParamsOnly: Decodable { var params: JSONValue? }

	private func handle(_ data: Data) {
		guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return }
		if let method = envelope.method {
			// The params' raw JSON: re-encoded once here, decoded by the one handler that knows its shape.
			let params = (try? JSONDecoder().decode(ParamsOnly.self, from: data).params).flatMap { try? JSONEncoder().encode($0) } ?? Data("{}".utf8)
			notify.yield(EngineNotification(method: method, params: params))
			return
		}
		guard let id = envelope.id, let waiter = waiting.removeValue(forKey: id) else { return }
		if let failure = envelope.error {
			waiter.resume(throwing: EngineError(code: failure.code, message: failure.message))
		} else {
			waiter.resume(returning: data)
		}
	}

	private func lost(_ reason: String) async {
		task?.cancel(with: .goingAway, reason: nil)
		task = nil
		failAll(.lost)
		guard started else { return }
		stateOut.yield(.lost(reason))
		attempt += 1
		let delay = min(5.0, 0.25 * pow(2.0, Double(min(attempt, 5))))
		try? await Task.sleep(for: .seconds(delay))
		await connect()
	}

	private func failAll(_ error: EngineError) {
		let pending = waiting
		waiting.removeAll()
		for waiter in pending.values { waiter.resume(throwing: error) }
	}

	private struct Request<P: Encodable>: Encodable {
		var jsonrpc = "2.0"
		var id: Int
		var method: String
		var params: P
	}

	private struct ResultOf<R: Decodable>: Decodable { var result: R }

	/// One request. Throws `EngineError` with the engine's own message when it refuses.
	public func call<P: Encodable & Sendable, R: Decodable & Sendable>(_ method: String, _ params: P, as _: R.Type = R.self) async throws -> R {
		guard let socket = task else { throw EngineError.notConnected }
		let id = nextId
		nextId += 1
		let body = try JSONEncoder().encode(Request(id: id, method: method, params: params))
		let data: Data = try await withCheckedThrowingContinuation { continuation in
			waiting[id] = continuation
			socket.send(.string(String(decoding: body, as: UTF8.self))) { error in
				if error != nil { Task { await self.fail(id: id) } }
			}
		}
		do {
			return try JSONDecoder().decode(ResultOf<R>.self, from: data).result
		} catch {
			throw EngineError(code: -32700, message: "The engine's answer to \(method) didn't read: \(error.localizedDescription)")
		}
	}

	private func fail(id: Int) {
		waiting.removeValue(forKey: id)?.resume(throwing: EngineError.lost)
	}

	/// For requests whose answer the caller doesn't need.
	public func send<P: Encodable & Sendable>(_ method: String, _ params: P) async throws {
		let _: JSONValue = try await call(method, params)
	}
}

/// Params for requests that take none.
public struct NoParams: Encodable, Sendable {
	public init() {}
}
