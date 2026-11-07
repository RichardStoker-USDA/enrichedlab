import Foundation

/// One durable event of a session's log (packages/protocol, SessionEvent). An event this app doesn't know yet decodes
/// as `.unknown`, so a newer engine never stops an older window from opening a session.
public enum SessionEvent: Decodable, Sendable, Hashable, Identifiable {
	public struct Header: Decodable, Sendable, Hashable {
		public struct Worktree: Decodable, Sendable, Hashable {
			public var repo: String
			public var path: String
			public var branch: String
		}

		public var id: String
		public var at: String
		public var cwd: String
		public var created: String
		public var site: String?
		public var parent: String?
		public var mode: String?
		public var worktree: Worktree?
	}

	public struct User: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var text: String
		public var images: [Part]?
	}

	public struct Assistant: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var model: String
		public var text: String
		public var reasoning: String?
		public var toolCalls: [ToolCall]?
		public var usage: Usage?
		/// end, tool_use, length, error, cancelled
		public var stop: String
		public var error: String?
		public var ms: Double?
	}

	public struct Tool: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var callId: String
		public var name: String
		public var ok: Bool
		public var content: String
		public var images: [Part]?
		public var view: StepView?
		public var handle: String?
		/// auto, allowed, allowed_session, denied, refused
		public var decision: String?
	}

	public struct Compaction: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var summary: String
		public var firstKeptId: String
		public var tokensBefore: Int
		public var model: String
	}

	public struct ModelChange: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var model: String
		public var effort: String?
	}

	public struct Title: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var title: String
	}

	public struct Notice: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		/// info, warn, error
		public var level: String
		public var text: String
	}

	public struct Undo: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var files: [String]
		public var all: Bool?
	}

	public struct Place: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var place: String
		public var label: String
		public var root: String
		public var initial: Bool?
	}

	public struct Discovery: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var on: Bool
		public var site: String
	}

	public struct ReasoningSummary: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var of: String
		public var text: String
		public var model: String
	}

	public struct AppContext: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var app: String
		public var title: String
		public var text: String
	}

	/// Events the window has no use for (checkpoints, elisions), or kinds newer than this app.
	public struct Other: Decodable, Sendable, Hashable {
		public var id: String
		public var at: String
		public var t: String
	}

	case header(Header)
	case user(User)
	case assistant(Assistant)
	case tool(Tool)
	case compaction(Compaction)
	case model(ModelChange)
	case title(Title)
	case notice(Notice)
	case undo(Undo)
	case place(Place)
	case discovery(Discovery)
	case reasoningSummary(ReasoningSummary)
	case appContext(AppContext)
	case other(Other)

	private enum Key: String, CodingKey { case t }

	public init(from decoder: any Decoder) throws {
		let kind = try decoder.container(keyedBy: Key.self).decode(String.self, forKey: .t)
		switch kind {
		case "header": self = .header(try Header(from: decoder))
		case "user": self = .user(try User(from: decoder))
		case "assistant": self = .assistant(try Assistant(from: decoder))
		case "tool": self = .tool(try Tool(from: decoder))
		case "compaction": self = .compaction(try Compaction(from: decoder))
		case "model": self = .model(try ModelChange(from: decoder))
		case "title": self = .title(try Title(from: decoder))
		case "notice": self = .notice(try Notice(from: decoder))
		case "undo": self = .undo(try Undo(from: decoder))
		case "place": self = .place(try Place(from: decoder))
		case "discovery": self = .discovery(try Discovery(from: decoder))
		case "reasoning_summary": self = .reasoningSummary(try ReasoningSummary(from: decoder))
		case "app_context": self = .appContext(try AppContext(from: decoder))
		default: self = .other(try Other(from: decoder))
		}
	}

	public var id: String {
		switch self {
		case let .header(e): e.id
		case let .user(e): e.id
		case let .assistant(e): e.id
		case let .tool(e): e.id
		case let .compaction(e): e.id
		case let .model(e): e.id
		case let .title(e): e.id
		case let .notice(e): e.id
		case let .undo(e): e.id
		case let .place(e): e.id
		case let .discovery(e): e.id
		case let .reasoningSummary(e): e.id
		case let .appContext(e): e.id
		case let .other(e): e.id
		}
	}
}
