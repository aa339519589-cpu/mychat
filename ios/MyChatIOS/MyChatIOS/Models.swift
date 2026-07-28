import Foundation

struct MobileBootstrap: Decodable {
    let supabaseUrl: URL
    let supabaseAnonKey: String
}

struct AuthSession: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    let expiresAt: TimeInterval?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresAt = "expires_at"
    }
}

struct Conversation: Codable, Identifiable, Hashable {
    let id: UUID
    var title: String
    let updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, title
        case updatedAt = "updated_at"
    }
}

struct ChatMessage: Codable, Identifiable, Hashable {
    let id: UUID
    let role: String
    var content: String
    let createdAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, role, content
        case createdAt = "created_at"
    }
}

struct ChatEnqueueResponse: Decodable {
    let jobId: UUID
    let streamUrl: String
}

struct JobEvent: Decodable {
    let jobId: UUID
    let seq: Int
    let kind: String
    let payload: [String: JSONValue]
}

enum JSONValue: Decodable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try box.decode([JSONValue].self)) }
    }

    var string: String? { if case let .string(value) = self { value } else { nil } }
    var object: [String: JSONValue]? { if case let .object(value) = self { value } else { nil } }
}
