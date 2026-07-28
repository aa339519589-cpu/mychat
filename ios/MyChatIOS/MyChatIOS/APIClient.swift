import Foundation

enum APIError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(value) = self { value } else { nil } }
}

actor APIClient {
    private let baseURL: URL
    private var bootstrap: MobileBootstrap?
    private var session: AuthSession?
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()

    init(baseURL: URL = AppConfig.apiBaseURL) {
        self.baseURL = baseURL
        self.session = KeychainStore.load()
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
    }

    var isSignedIn: Bool { session != nil }

    func signIn(email: String, password: String) async throws {
        let config = try await loadBootstrap()
        var request = URLRequest(url: config.supabaseUrl.appending(path: "auth/v1/token"))
        request.httpMethod = "POST"
        request.setValue(config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(["email": email, "password": password])
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
        request.url = components.url
        let value: AuthSession = try await send(request)
        session = value
        try KeychainStore.save(value)
    }

    func signOut() { session = nil; KeychainStore.clear() }

    func conversations() async throws -> [Conversation] {
        let config = try await loadBootstrap()
        let url = try restURL(config, path: "conversations", query: [
            "select": "id,title,updated_at", "order": "updated_at.desc", "limit": "100",
        ])
        var request = authorizedRequest(url, config: config)
        request.httpMethod = "GET"
        return try await send(request)
    }

    func messages(conversationID: UUID) async throws -> [ChatMessage] {
        let config = try await loadBootstrap()
        let url = try restURL(config, path: "messages", query: [
            "select": "id,role,content,created_at", "conversation_id": "eq.\(conversationID.uuidString)",
            "order": "created_at.asc", "limit": "200",
        ])
        var request = authorizedRequest(url, config: config)
        request.httpMethod = "GET"
        return try await send(request)
    }

    func send(text: String, conversationID: UUID, history: [ChatMessage]) async throws -> AsyncThrowingStream<String, Error> {
        guard let token = session?.accessToken else { throw APIError.message("登录已过期") }
        let userID = UUID()
        let assistantID = UUID()
        let generationID = UUID()
        let all = history + [ChatMessage(id: userID, role: "user", content: text, createdAt: Date())]
        let body: [String: Any] = [
            "tier": "绝句", "conversationId": conversationID.uuidString,
            "userMessageId": userID.uuidString, "assistantMessageId": assistantID.uuidString,
            "generationId": generationID.uuidString,
            "messages": all.map { ["id": $0.id.uuidString, "role": $0.role, "content": $0.content, "ts": ISO8601DateFormatter().string(from: $0.createdAt ?? Date())] },
            "turn": ["schemaVersion": 1, "createConversation": history.isEmpty, "title": history.isEmpty ? String(text.prefix(32)) : "", "projectId": NSNull()],
        ]
        var request = URLRequest(url: baseURL.appending(path: "api/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let accepted: ChatEnqueueResponse = try await send(request)
        return stream(path: accepted.streamUrl, token: token)
    }

    private func stream(path: String, token: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = path.hasPrefix("http")
                        ? URL(string: path)
                        : URL(string: path, relativeTo: baseURL)?.absoluteURL else {
                        throw APIError.message("流式地址无效")
                    }
                    var request = URLRequest(url: url)
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else { throw APIError.message("流式连接失败") }
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            try emit(dataLines, into: continuation)
                            dataLines.removeAll()
                        } else if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func emit(_ lines: [String], into continuation: AsyncThrowingStream<String, Error>.Continuation) throws {
        guard !lines.isEmpty else { return }
        let raw = lines.joined(separator: "\n")
        guard raw != "[DONE]", let data = raw.data(using: .utf8) else { return }
        let event = try decoder.decode(JobEvent.self, from: data)
        if event.kind == "job.terminal" {
            // Deltas have already been rendered. The caller refreshes history
            // after the terminal event so the durable final snapshot wins
            // without duplicating the streamed text in the UI.
            return
        }
        if let text = event.payload["text"]?.string { continuation.yield(text) }
        if let error = event.payload["error"]?.string { throw APIError.message(error) }
    }

    private func loadBootstrap() async throws -> MobileBootstrap {
        if let bootstrap { return bootstrap }
        let request = URLRequest(url: baseURL.appending(path: "api/mobile/config"))
        let value: MobileBootstrap = try await send(request)
        bootstrap = value
        return value
    }

    private func restURL(_ config: MobileBootstrap, path: String, query: [String: String]) throws -> URL {
        var components = URLComponents(url: config.supabaseUrl.appending(path: "rest/v1/\(path)"), resolvingAgainstBaseURL: false)!
        components.queryItems = query.map(URLQueryItem.init(name:value:))
        guard let url = components.url else { throw APIError.message("请求地址无效") }
        return url
    }

    private func authorizedRequest(_ url: URL, config: MobileBootstrap) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue(config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(session?.accessToken ?? "")", forHTTPHeaderField: "Authorization")
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.message("网络响应无效") }
        guard 200..<300 ~= http.statusCode else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.message(message ?? "请求失败（\(http.statusCode)）")
        }
        return try decoder.decode(T.self, from: data)
    }
}
