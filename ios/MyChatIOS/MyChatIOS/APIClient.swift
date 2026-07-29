import Foundation

enum APIError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        if case let .message(value) = self { return value }
        return nil
    }
}

actor APIClient {
    private let baseURL: URL
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()
    private var bootstrap: MobileBootstrap?
    private var session: AuthSession?

    init(baseURL: URL = AppConfig.apiBaseURL) {
        self.baseURL = baseURL
        self.session = KeychainStore.load()
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) { return date }
            let standard = ISO8601DateFormatter()
            if let date = standard.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(
                in: try decoder.singleValueContainer(),
                debugDescription: "Invalid ISO-8601 date"
            )
        }
    }

    func restoreSession() async -> Bool {
        guard session != nil else { return false }
        do {
            let config = try await loadBootstrap()
            var request = URLRequest(url: config.supabaseUrl.appending(path: "auth/v1/user"))
            request.setValue(config.supabaseAnonKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return false }
            if http.statusCode == 401 {
                _ = try await refreshSession()
                return true
            }
            return 200..<300 ~= http.statusCode
        } catch {
            return false
        }
    }

    func signIn(email: String, password: String) async throws {
        let config = try await loadBootstrap()
        var components = URLComponents(
            url: config.supabaseUrl.appending(path: "auth/v1/token"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(["email": email, "password": password])
        try saveSession(try await send(request))
    }

    func signOut() {
        session = nil
        KeychainStore.clear()
    }

    func conversations() async throws -> [Conversation] {
        let config = try await loadBootstrap()
        let url = try restURL(config, path: "conversations", query: [
            "select": "id,title,updated_at",
            "order": "updated_at.desc",
            "limit": "100",
        ])
        let request = try await authorizedRequest(url, config: config)
        return try await send(request)
    }

    func messages(conversationID: UUID) async throws -> [ChatMessage] {
        let config = try await loadBootstrap()
        let url = try restURL(config, path: "messages", query: [
            "select": "id,role,content,created_at",
            "conversation_id": "eq.\(conversationID.uuidString)",
            "order": "created_at.asc",
            "limit": "300",
        ])
        let request = try await authorizedRequest(url, config: config)
        return try await send(request)
    }

    func models() async throws -> [ModelChoice] {
        let config = try await loadBootstrap()
        let url = try restURL(config, path: "endpoints", query: [
            "select": "id,name,model,output_kind",
            "output_kind": "eq.chat",
            "order": "updated_at.desc",
        ])
        let request = try await authorizedRequest(url, config: config)
        let endpoints: [EndpointRow]
        do {
            endpoints = try await send(request)
        } catch {
            return ModelChoice.platform
        }
        return ModelChoice.platform + endpoints.map {
            ModelChoice(
                id: "endpoint-\($0.id.uuidString)",
                name: $0.name.isEmpty ? $0.model : $0.name,
                detail: $0.model,
                selection: .endpoint(id: $0.id)
            )
        }
    }

    func enqueue(
        text: String,
        conversationID: UUID,
        history: [ChatMessage],
        model: ModelChoice,
        createConversation: Bool,
        conversationTitle: String,
        userMessageID: UUID,
        assistantMessageID: UUID,
        generationID: UUID
    ) async throws -> ChatEnqueueResponse {
        let token = try await accessToken()
        let userMessage = ChatMessage(
            id: userMessageID,
            role: "user",
            content: text,
            createdAt: Date()
        )
        let messages = history + [userMessage]
        let title = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        var body: [String: Any] = [
            "conversationId": conversationID.uuidString,
            "userMessageId": userMessageID.uuidString,
            "assistantMessageId": assistantMessageID.uuidString,
            "generationId": generationID.uuidString,
            "messages": messages.map {
                [
                    "id": $0.id.uuidString,
                    "role": $0.role,
                    "content": $0.content,
                    "ts": ISO8601DateFormatter().string(from: $0.createdAt ?? Date()),
                ]
            },
            "turn": [
                "schemaVersion": 1,
                "createConversation": createConversation,
                "title": String((conversationTitle.isEmpty ? title : conversationTitle).prefix(200)),
                "projectId": NSNull(),
            ],
        ]
        switch model.selection {
        case let .platform(tier):
            body["tier"] = tier
        case let .endpoint(id):
            body["endpointId"] = id.uuidString
        }

        var request = URLRequest(url: baseURL.appending(path: "api/chat"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    func eventStream(_ accepted: ChatEnqueueResponse) -> AsyncThrowingStream<JobEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await consumeEvents(accepted, continuation: continuation)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func consumeEvents(
        _ accepted: ChatEnqueueResponse,
        continuation: AsyncThrowingStream<JobEvent, Error>.Continuation
    ) async throws {
        var sequence = 0
        var retryNanoseconds: UInt64 = 250_000_000
        let deadline = Date().addingTimeInterval(20 * 60)

        while !Task.isCancelled && Date() < deadline {
            do {
                let terminal = try await consumeConnection(
                    path: accepted.streamUrl,
                    fromSequence: &sequence,
                    continuation: continuation
                )
                if terminal { return }
                retryNanoseconds = 250_000_000
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if Date() >= deadline { throw error }
            }
            try await Task.sleep(nanoseconds: retryNanoseconds)
            retryNanoseconds = min(5_000_000_000, retryNanoseconds * 2)
        }
        if !Task.isCancelled { throw APIError.message("回复连接超时") }
    }

    private func consumeConnection(
        path: String,
        fromSequence sequence: inout Int,
        continuation: AsyncThrowingStream<JobEvent, Error>.Continuation
    ) async throws -> Bool {
        guard var components = URLComponents(
            url: URL(string: path, relativeTo: baseURL)?.absoluteURL ?? baseURL,
            resolvingAgainstBaseURL: false
        ) else { throw APIError.message("流式地址无效") }
        var query = components.queryItems ?? []
        query.removeAll { $0.name == "from_seq" }
        query.append(URLQueryItem(name: "from_seq", value: String(sequence)))
        components.queryItems = query
        guard let url = components.url else { throw APIError.message("流式地址无效") }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if sequence > 0 { request.setValue(String(sequence), forHTTPHeaderField: "Last-Event-ID") }
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.message("流式响应无效")
        }
        guard 200..<300 ~= http.statusCode else {
            throw APIError.message("流式连接失败（\(http.statusCode)）")
        }

        var dataLines: [String] = []
        for try await line in bytes.lines {
            try Task.checkCancellation()
            if line.isEmpty {
                guard let event = try decodeEvent(dataLines) else {
                    dataLines.removeAll(keepingCapacity: true)
                    continue
                }
                dataLines.removeAll(keepingCapacity: true)
                guard event.seq > sequence else { continue }
                if event.seq != sequence + 1 { throw APIError.message("回复事件出现缺口，正在重连") }
                sequence = event.seq
                continuation.yield(event)
                if event.kind == "job.terminal" { return true }
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
        }
        return false
    }

    private func decodeEvent(_ lines: [String]) throws -> JobEvent? {
        guard !lines.isEmpty else { return nil }
        let raw = lines.joined(separator: "\n")
        guard raw != "[DONE]", let data = raw.data(using: .utf8) else { return nil }
        return try decoder.decode(JobEvent.self, from: data)
    }

    private func loadBootstrap() async throws -> MobileBootstrap {
        if let bootstrap { return bootstrap }
        let request = URLRequest(url: baseURL.appending(path: "api/mobile/config"))
        let value: MobileBootstrap = try await send(request)
        bootstrap = value
        return value
    }

    private func accessToken() async throws -> String {
        guard let current = session else { throw APIError.message("请先登录") }
        if let expiresAt = current.expiresAt, expiresAt <= Date().timeIntervalSince1970 + 60 {
            return try await refreshSession().accessToken
        }
        return current.accessToken
    }

    private func refreshSession() async throws -> AuthSession {
        guard let current = session else { throw APIError.message("登录已过期") }
        let config = try await loadBootstrap()
        var components = URLComponents(
            url: config.supabaseUrl.appending(path: "auth/v1/token"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token")]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(["refresh_token": current.refreshToken])
        let refreshed: AuthSession = try await send(request)
        try saveSession(refreshed)
        return refreshed
    }

    private func saveSession(_ value: AuthSession) throws {
        session = value
        try KeychainStore.save(value)
    }

    private func restURL(
        _ config: MobileBootstrap,
        path: String,
        query: [String: String]
    ) throws -> URL {
        var components = URLComponents(
            url: config.supabaseUrl.appending(path: "rest/v1/\(path)"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = query.map(URLQueryItem.init(name:value:))
        guard let url = components.url else { throw APIError.message("请求地址无效") }
        return url
    }

    private func authorizedRequest(_ url: URL, config: MobileBootstrap) async throws -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue(config.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
        return request
    }

    private func responseMessage(_ data: Data, status: Int) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return "请求失败（\(status)）"
        }
        if let error = object["error"] as? String { return error }
        if let message = object["msg"] as? String { return message }
        if let message = object["message"] as? String { return message }
        if let message = object["error_description"] as? String { return message }
        if let error = object["error"] as? [String: Any],
           let message = error["message"] as? String { return message }
        return "请求失败（\(status)）"
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.message("网络响应无效")
        }
        guard 200..<300 ~= http.statusCode else {
            throw APIError.message(responseMessage(data, status: http.statusCode))
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.message("服务器响应格式无法识别")
        }
    }
}
