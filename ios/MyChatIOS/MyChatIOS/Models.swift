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

struct ModelChoice: Identifiable, Hashable {
    enum Selection: Hashable {
        case platform(tier: String)
        case endpoint(id: UUID)
    }

    let id: String
    let name: String
    let detail: String
    let selection: Selection

    static let platform: [ModelChoice] = [
        ModelChoice(id: "platform-deep", name: "深度", detail: "深入思考", selection: .platform(tier: "鸿篇")),
        ModelChoice(id: "platform-balanced", name: "均衡", detail: "思考与速度平衡", selection: .platform(tier: "正构")),
        ModelChoice(id: "platform-fast", name: "快速", detail: "快速响应", selection: .platform(tier: "绝句")),
    ]
}

struct EndpointRow: Decodable {
    let id: UUID
    let name: String
    let model: String
    let outputKind: String?

    enum CodingKeys: String, CodingKey {
        case id, name, model
        case outputKind = "output_kind"
    }
}

struct ChatEnqueueResponse: Decodable {
    let jobId: UUID
    let streamUrl: String
    let status: String
}

struct JobEvent: Decodable {
    let jobId: UUID
    let seq: Int
    let kind: String
    let payload: [String: JSONValue]
}

enum JSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try box.decode([JSONValue].self)) }
    }

    var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }
}
