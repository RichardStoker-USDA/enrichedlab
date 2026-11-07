import Foundation

/// Any JSON value. The protocol's free-form fields (tool arguments, lab answers, app results) arrive as this, so a newer
/// engine's additions never break decoding.
public enum JSONValue: Codable, Sendable, Hashable {
	case null
	case bool(Bool)
	case number(Double)
	case string(String)
	case array([JSONValue])
	case object([String: JSONValue])

	public init(from decoder: any Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			self = .null
		} else if let value = try? container.decode(Bool.self) {
			self = .bool(value)
		} else if let value = try? container.decode(Double.self) {
			self = .number(value)
		} else if let value = try? container.decode(String.self) {
			self = .string(value)
		} else if let value = try? container.decode([JSONValue].self) {
			self = .array(value)
		} else {
			self = .object(try container.decode([String: JSONValue].self))
		}
	}

	public func encode(to encoder: any Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case .null: try container.encodeNil()
		case let .bool(value): try container.encode(value)
		case let .number(value): try container.encode(value)
		case let .string(value): try container.encode(value)
		case let .array(value): try container.encode(value)
		case let .object(value): try container.encode(value)
		}
	}

	public subscript(key: String) -> JSONValue? {
		if case let .object(object) = self { return object[key] }
		return nil
	}

	public var string: String? {
		if case let .string(value) = self { return value }
		return nil
	}

	public var number: Double? {
		if case let .number(value) = self { return value }
		return nil
	}

	public var bool: Bool? {
		if case let .bool(value) = self { return value }
		return nil
	}

	public var array: [JSONValue]? {
		if case let .array(value) = self { return value }
		return nil
	}

	/// Compact JSON text, for showing arguments and answers.
	public var text: String {
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
		guard let data = try? encoder.encode(self) else { return "" }
		return String(decoding: data, as: UTF8.self)
	}
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral {
	public init(stringLiteral value: String) { self = .string(value) }
	public init(booleanLiteral value: Bool) { self = .bool(value) }
	public init(integerLiteral value: Int) { self = .number(Double(value)) }
	public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last })) }
	public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}
