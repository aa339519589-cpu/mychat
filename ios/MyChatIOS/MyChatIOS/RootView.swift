import SwiftUI

enum AppPalette {
    static let background = Color(uiColor: .systemBackground)
    static let surface = Color(uiColor: .systemBackground)
    static let mutedSurface = Color(uiColor: .secondarySystemBackground)
    static let elevatedSurface = Color(uiColor: .tertiarySystemBackground)
    static let border = Color(uiColor: .separator).opacity(0.52)
    static let text = Color(uiColor: .label)
    static let secondaryText = Color(uiColor: .secondaryLabel)
}

@MainActor
final class SessionStore: ObservableObject {
    enum Phase {
        case restoring
        case signedOut
        case signedIn
    }

    @Published var phase: Phase = .restoring
    let api = APIClient()

    func restore() async {
        phase = await api.restoreSession() ? .signedIn : .signedOut
    }

    func signIn(email: String, password: String) async throws {
        try await api.signIn(email: email, password: password)
        phase = .signedIn
    }

    func signOut() {
        Task { await api.signOut() }
        phase = .signedOut
    }
}

struct RootView: View {
    @StateObject private var session = SessionStore()

    var body: some View {
        Group {
            switch session.phase {
            case .restoring:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(AppPalette.background)
            case .signedOut:
                LoginView(session: session)
            case .signedIn:
                NativeChatView(api: session.api, onSignOut: session.signOut)
                    .id("native-chat")
            }
        }
        .task {
            guard session.phase == .restoring else { return }
            await session.restore()
        }
    }
}

struct LoginView: View {
    @ObservedObject var session: SessionStore
    @State private var email = ""
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var error: String?
    @FocusState private var focusedField: Field?

    private enum Field {
        case email
        case password
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 10) {
                Text("MyChat")
                    .font(.system(size: 34, weight: .semibold))
                Text("登录后继续你的对话")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 36)

            VStack(spacing: 14) {
                TextField("邮箱", text: $email)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.emailAddress)
                    .textContentType(.username)
                    .focused($focusedField, equals: .email)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .password }
                    .nativeField()

                SecureField("密码", text: $password)
                    .textContentType(.password)
                    .focused($focusedField, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { submitLogin() }
                    .nativeField()

                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button(action: submitLogin) {
                    Group {
                        if isSubmitting { ProgressView().tint(.white) }
                        else { Text("登录").fontWeight(.semibold) }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .background(Color.primary)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .disabled(email.isEmpty || password.isEmpty || isSubmitting)
                .opacity(email.isEmpty || password.isEmpty ? 0.45 : 1)

            }
            .frame(maxWidth: 420)
            Spacer()
            Text("原生 iPhone 客户端 · 1.1")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.bottom, 12)
        }
        .padding(.horizontal, 24)
        .background(AppPalette.background.ignoresSafeArea())
    }

    private func submitLogin() {
        guard !email.isEmpty, !password.isEmpty, !isSubmitting else { return }
        Task {
            isSubmitting = true
            error = nil
            defer { isSubmitting = false }
            do {
                try await session.signIn(
                    email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                    password: password
                )
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

}

private extension View {
    func nativeField() -> some View {
        self
            .font(.body)
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(Color(uiColor: .secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

@MainActor
final class ChatStore: ObservableObject {
    private enum SavedModelSelection: Codable {
        case platform(tier: String)
        case endpoint(id: UUID)

        private enum CodingKeys: String, CodingKey { case kind, tier, id }
        private enum Kind: String, Codable { case platform, endpoint }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            switch try values.decode(Kind.self, forKey: .kind) {
            case .platform:
                self = .platform(tier: try values.decode(String.self, forKey: .tier))
            case .endpoint:
                self = .endpoint(id: try values.decode(UUID.self, forKey: .id))
            }
        }

        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case let .platform(tier):
                try values.encode(Kind.platform, forKey: .kind)
                try values.encode(tier, forKey: .tier)
            case let .endpoint(id):
                try values.encode(Kind.endpoint, forKey: .kind)
                try values.encode(id, forKey: .id)
            }
        }
    }

    private static let modelSelectionKey = "com.mychat.ios.selected-model.v1"
    private struct RetryContext {
        let text: String
        let userID: UUID
        let assistantID: UUID
    }

    @Published var conversations: [Conversation] = []
    @Published var selectedConversation: Conversation?
    @Published var messages: [ChatMessage] = []
    @Published var models: [ModelChoice] = ModelChoice.platform
    @Published var selectedModel: ModelChoice = ModelChoice.platform[1]
    @Published var isLoading = true
    @Published var isSending = false
    @Published var error: String?
    @Published var failedMessageID: UUID?

    private let api: APIClient
    private var streamTask: Task<Void, Never>?
    private var retryContext: RetryContext?

    init(api: APIClient) {
        self.api = api
    }

    deinit {
        streamTask?.cancel()
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            models = try await api.models()
            restoreSavedModelSelection()
            conversations = try await api.conversations()
            if let first = conversations.first {
                try await select(first)
            } else {
                newConversation()
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func select(_ conversation: Conversation) async throws {
        guard selectedConversation?.id != conversation.id || messages.isEmpty else { return }
        streamTask?.cancel()
        isSending = false
        failedMessageID = nil
        retryContext = nil
        selectedConversation = conversation
        messages = try await api.messages(conversationID: conversation.id)
    }

    func newConversation() {
        streamTask?.cancel()
        selectedConversation = Conversation(id: UUID(), title: "新对话", updatedAt: nil)
        messages = []
        isSending = false
        failedMessageID = nil
        retryContext = nil
    }

    func selectModel(_ model: ModelChoice) {
        selectedModel = model
        guard let saved = savedSelection(for: model),
              let data = try? JSONEncoder().encode(saved) else { return }
        UserDefaults.standard.set(data, forKey: Self.modelSelectionKey)
    }

    private func restoreSavedModelSelection() {
        guard
            let data = UserDefaults.standard.data(forKey: Self.modelSelectionKey),
            let saved = try? JSONDecoder().decode(SavedModelSelection.self, from: data)
        else {
            selectedModel = models.first(where: { $0 == selectedModel })
                ?? ModelChoice.platform[1]
            return
        }

        let restored: ModelChoice?
        switch saved {
        case let .platform(tier):
            restored = models.first {
                if case let .platform(candidate) = $0.selection { return candidate == tier }
                return false
            }
        case let .endpoint(id):
            restored = models.first {
                if case let .endpoint(candidate) = $0.selection { return candidate == id }
                return false
            }
        }
        if let restored {
            selectedModel = restored
        } else {
            // A deleted or reconnected endpoint must never leave the composer
            // pointing at an ID the server can no longer resolve.
            UserDefaults.standard.removeObject(forKey: Self.modelSelectionKey)
            selectedModel = ModelChoice.platform[1]
        }
    }

    private func savedSelection(for model: ModelChoice) -> SavedModelSelection? {
        switch model.selection {
        case let .platform(tier): return .platform(tier: tier)
        case let .endpoint(id): return .endpoint(id: id)
        }
    }

    func send(_ value: String) {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        if selectedConversation == nil { newConversation() }
        guard let conversation = selectedConversation else { return }

        let history = messages
        let userID = UUID()
        let assistantID = UUID()
        let generationID = UUID()
        let createConversation = !conversations.contains { $0.id == conversation.id }
        failedMessageID = nil
        retryContext = nil
        messages.append(ChatMessage(id: userID, role: "user", content: text, createdAt: Date()))
        messages.append(ChatMessage(id: assistantID, role: "assistant", content: "", createdAt: Date()))
        isSending = true

        streamTask = Task {
            defer { isSending = false }
            do {
                let accepted = try await api.enqueue(
                    text: text,
                    conversationID: conversation.id,
                    history: history,
                    model: selectedModel,
                    createConversation: createConversation,
                    conversationTitle: createConversation ? text : conversation.title,
                    userMessageID: userID,
                    assistantMessageID: assistantID,
                    generationID: generationID
                )
                let stream = await api.eventStream(accepted)
                for try await event in stream {
                    if event.kind == "text.delta", let delta = event.payload["text"]?.string {
                        append(delta, to: assistantID)
                    }
                    if event.kind == "thinking.delta",
                       let delta = event.payload["thinking"]?.string {
                        appendThinking(delta, to: assistantID)
                    }
                    if event.kind == "job.retry_scheduled" {
                        resetAssistant(assistantID)
                    }
                    if event.kind == "job.warning", let message = event.payload["message"]?.string {
                        error = message
                    }
                    if event.kind == "job.terminal",
                       let status = event.payload["status"]?.string,
                       status != "completed" {
                        throw APIError.message(event.payload["error"]?.string ?? "生成未完成")
                    }
                    if event.kind == "job.terminal",
                       let result = event.payload["result"]?.object {
                        applyTerminal(result, to: assistantID)
                    }
                }
                try await refresh(conversationID: conversation.id)
            } catch is CancellationError {
                return
            } catch {
                replaceEmptyAssistant(assistantID, with: "发送失败")
                failedMessageID = assistantID
                retryContext = RetryContext(text: text, userID: userID, assistantID: assistantID)
                self.error = error.localizedDescription
            }
        }
    }

    func retryFailedMessage() {
        guard let retryContext else { return }
        messages.removeAll {
            $0.id == retryContext.userID || $0.id == retryContext.assistantID
        }
        failedMessageID = nil
        self.retryContext = nil
        send(retryContext.text)
    }

    private func append(_ delta: String, to id: UUID) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].content += delta
    }

    private func appendThinking(_ delta: String, to id: UUID) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].thinking = (messages[index].thinking ?? "") + delta
    }

    private func resetAssistant(_ id: UUID) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].content = ""
        messages[index].thinking = nil
    }

    private func applyTerminal(_ result: [String: JSONValue], to id: UUID) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        if let content = result["content"]?.string {
            messages[index].content = content
        }
        if let thinking = result["thinking"]?.string {
            messages[index].thinking = thinking.isEmpty ? nil : thinking
        }
    }

    private func replaceEmptyAssistant(_ id: UUID, with value: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }),
              messages[index].content.isEmpty else { return }
        messages[index].content = value
    }

    private func refresh(conversationID: UUID) async throws {
        failedMessageID = nil
        retryContext = nil
        messages = try await api.messages(conversationID: conversationID)
        conversations = try await api.conversations()
        selectedConversation = conversations.first(where: { $0.id == conversationID })
            ?? selectedConversation
    }
}

struct NativeChatView: View {
    let onSignOut: () -> Void
    @StateObject private var store: ChatStore
    @State private var sidebarVisible = false
    @State private var attachmentSheetVisible = false
    @State private var destination: WorkspaceDestination?
    @State private var draft = ""
    @FocusState private var composerFocused: Bool

    init(api: APIClient, onSignOut: @escaping () -> Void) {
        _store = StateObject(wrappedValue: ChatStore(api: api))
        self.onSignOut = onSignOut
    }

    var body: some View {
        ZStack(alignment: .leading) {
            AppPalette.background.ignoresSafeArea()
            VStack(spacing: 0) {
                ChatTopBar(
                    models: store.models,
                    selected: store.selectedModel,
                    openSidebar: { sidebarVisible = true },
                    selectModel: store.selectModel,
                    newConversation: store.newConversation
                )
                if store.messages.isEmpty {
                    Color.clear
                } else {
                    MessageList(
                        messages: store.messages,
                        isSending: store.isSending,
                        failedMessageID: store.failedMessageID,
                        retry: store.retryFailedMessage
                    )
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Composer(
                    draft: $draft,
                    isFocused: $composerFocused,
                    isSending: store.isSending,
                    openAttachments: {
                        composerFocused = false
                        attachmentSheetVisible = true
                    },
                    send: {
                        let value = draft
                        draft = ""
                        store.send(value)
                    },
                    reportError: { store.error = $0 }
                )
            }
            .disabled(sidebarVisible)

            if !sidebarVisible {
                Color.clear
                    .frame(width: 18)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 18)
                            .onEnded { value in
                                guard value.translation.width > 54,
                                      abs(value.translation.height) < 90 else { return }
                                lightHaptic()
                                withAnimation(.interactiveSpring(response: 0.3, dampingFraction: 0.9)) {
                                    sidebarVisible = true
                                }
                            }
                    )
            }

            if sidebarVisible {
                SidebarOverlay(
                    conversations: store.conversations,
                    selected: store.selectedConversation,
                    close: { sidebarVisible = false },
                    select: { conversation in
                        sidebarVisible = false
                        Task {
                            do { try await store.select(conversation) }
                            catch { store.error = error.localizedDescription }
                        }
                    },
                    newConversation: {
                        store.newConversation()
                        sidebarVisible = false
                    },
                    openDestination: {
                        destination = $0
                        sidebarVisible = false
                    }
                )
                .transition(.asymmetric(
                    insertion: .opacity,
                    removal: .opacity
                ))
                .zIndex(2)
            }
        }
        .animation(.interactiveSpring(response: 0.3, dampingFraction: 0.9), value: sidebarVisible)
        .sheet(isPresented: $attachmentSheetVisible) {
            AttachmentActionsSheet()
                .presentationDetents([.height(370)])
                .presentationDragIndicator(.visible)
                .presentationBackground(AppPalette.background)
        }
        .sheet(item: $destination) { destination in
            WorkspaceDestinationView(destination: destination, signOut: onSignOut)
                .presentationBackground(AppPalette.background)
        }
        .alert(
            "提示",
            isPresented: Binding(
                get: { store.error != nil },
                set: { if !$0 { store.error = nil } }
            )
        ) {
            Button("好", role: .cancel) {}
        } message: {
            Text(store.error ?? "")
        }
        .task { await store.load() }
    }
}

struct ChatTopBar: View {
    let models: [ModelChoice]
    let selected: ModelChoice
    let openSidebar: () -> Void
    let selectModel: (ModelChoice) -> Void
    let newConversation: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: openSidebar) {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 20, weight: .medium))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("打开历史对话")

            Spacer(minLength: 0)
            Menu {
                ForEach(models) { model in
                    Button {
                        selectModel(model)
                    } label: {
                        if model == selected {
                            Label(model.name, systemImage: "checkmark")
                        } else {
                            Text(model.name)
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Text(selected.name)
                        .font(.system(size: 17, weight: .semibold))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 190)
                .contentShape(Rectangle())
                .frame(minHeight: 44)
            }
            .accessibilityLabel("当前模型，\(selected.name)")
            Spacer(minLength: 0)

            Button(action: newConversation) {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 19, weight: .medium))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("新对话")
        }
        .foregroundStyle(AppPalette.text)
        .padding(.horizontal, 12)
        .frame(height: 54)
        .background(AppPalette.background)
    }
}

struct MessageList: View {
    let messages: [ChatMessage]
    let isSending: Bool
    let failedMessageID: UUID?
    let retry: () -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(messages) { message in
                        NativeMessageRow(
                            message: message,
                            isActive: isSending && message.id == messages.last?.id,
                            failed: failedMessageID == message.id,
                            retry: retry
                        )
                            .id(message.id)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 18)
                .padding(.bottom, 24)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: messages) { _, value in
                guard let id = value.last?.id else { return }
                withAnimation(.easeOut(duration: 0.16)) {
                    proxy.scrollTo(id, anchor: .bottom)
                }
            }
            .onChange(of: isSending) { _, _ in
                guard let id = messages.last?.id else { return }
                proxy.scrollTo(id, anchor: .bottom)
            }
        }
    }
}

struct NativeMessageRow: View {
    let message: ChatMessage
    let isActive: Bool
    let failed: Bool
    let retry: () -> Void
    @State private var thinkingExpanded = false

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == "user" {
                Spacer(minLength: 64)
                Text(displayText)
                    .font(.system(size: 16))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .foregroundStyle(AppPalette.text)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 9)
                    .background(AppPalette.mutedSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    if let thinking = message.thinking, !thinking.isEmpty {
                        DisclosureGroup(isExpanded: $thinkingExpanded) {
                            Text(thinking)
                                .font(.system(size: 14))
                                .lineSpacing(3)
                                .foregroundStyle(.secondary)
                                .padding(.top, 6)
                                .textSelection(.enabled)
                        } label: {
                            Label(
                                isActive ? "正在思考" : "思考过程",
                                systemImage: "brain"
                            )
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.secondary)
                        }
                        .tint(.secondary)
                    }
                    if message.content.isEmpty && isActive {
                        NativeThinkingIndicator()
                    } else {
                        RichAssistantContent(text: displayText)
                    }
                    if failed {
                        Button(action: retry) {
                            Label("重试", systemImage: "arrow.clockwise")
                                .font(.system(size: 14, weight: .medium))
                                .frame(minHeight: 36)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var displayText: String {
        return message.content
    }
}

struct Composer: View {
    @Binding var draft: String
    let isFocused: FocusState<Bool>.Binding
    let isSending: Bool
    let openAttachments: () -> Void
    let send: () -> Void
    let reportError: (String) -> Void
    @StateObject private var speech = SpeechInput()

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            Button {
                lightHaptic()
                openAttachments()
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(AppPalette.text)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("添加")

            TextField("Ask anything", text: $draft, axis: .vertical)
                .font(.system(size: 17))
                .lineLimit(1...6)
                .focused(isFocused)
                .padding(.horizontal, 4)
                .padding(.vertical, 9)
                .disabled(isSending)

            Button(action: primaryAction) {
                Image(systemName: actionIcon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(actionForeground)
                    .frame(width: 44, height: 44)
                    .background {
                        if !draftIsEmpty {
                            Circle().fill(actionBackground)
                                .frame(width: 36, height: 36)
                        }
                    }
            }
            .disabled(isSending)
            .accessibilityLabel(draftIsEmpty ? (speech.isRecording ? "停止听写" : "语音输入") : "发送")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(AppPalette.surface)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(AppPalette.border)
                .frame(height: 0.5)
        }
        .onChange(of: speech.transcript) { _, value in
            if !value.isEmpty { draft = value }
        }
        .onChange(of: speech.error) { _, value in
            if let value {
                reportError(value)
                speech.error = nil
            }
        }
        .onDisappear { speech.stop() }
    }

    private var draftIsEmpty: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var actionIcon: String {
        if !draftIsEmpty { return "arrow.up" }
        return speech.isRecording ? "stop.fill" : "mic"
    }

    private var actionForeground: Color {
        if !draftIsEmpty { return Color(uiColor: .systemBackground) }
        return .primary
    }

    private var actionBackground: Color {
        if !draftIsEmpty { return .primary }
        return .clear
    }

    private func primaryAction() {
        lightHaptic()
        if draftIsEmpty {
            Task { await speech.toggle() }
        } else {
            speech.stop()
            send()
        }
    }
}

enum WorkspaceDestination: String, Identifiable {
    case projects
    case artifacts
    case code
    case profile
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .projects: return "项目"
        case .artifacts: return "作品"
        case .code: return "代码"
        case .profile: return "账户"
        case .settings: return "设置"
        }
    }

    var symbol: String {
        switch self {
        case .projects: return "folder"
        case .artifacts: return "square.grid.2x2"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .profile: return "person"
        case .settings: return "gearshape"
        }
    }
}

struct SidebarOverlay: View {
    let conversations: [Conversation]
    let selected: Conversation?
    let close: () -> Void
    let select: (Conversation) -> Void
    let newConversation: () -> Void
    let openDestination: (WorkspaceDestination) -> Void

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Color.black.opacity(0.22)
                    .ignoresSafeArea()
                    .onTapGesture(perform: close)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 11) {
                        MyChatMark()
                        Text("MyChat")
                            .font(.system(size: 20, weight: .semibold))
                        Spacer()
                        Button(action: close) {
                            Image(systemName: "xmark")
                                .font(.system(size: 14, weight: .semibold))
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("关闭侧边栏")
                    }
                    .padding(.leading, 18)
                    .padding(.trailing, 8)
                    .frame(height: 62)

                    VStack(spacing: 0) {
                        SidebarAction(title: "新对话", symbol: "square.and.pencil") {
                            lightHaptic()
                            newConversation()
                        }
                        SidebarAction(title: "项目", symbol: WorkspaceDestination.projects.symbol) {
                            openDestination(.projects)
                        }
                        SidebarAction(title: "作品", symbol: WorkspaceDestination.artifacts.symbol) {
                            openDestination(.artifacts)
                        }
                        SidebarAction(title: "代码", symbol: WorkspaceDestination.code.symbol) {
                            openDestination(.code)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 2)

                    Text("对话")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 20)
                        .padding(.top, 22)
                        .padding(.bottom, 8)

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(conversations) { conversation in
                                Button {
                                    lightHaptic()
                                    select(conversation)
                                } label: {
                                    HStack(spacing: 10) {
                                        Rectangle()
                                            .fill(selected?.id == conversation.id ? AppPalette.text : .clear)
                                            .frame(width: 2, height: 18)
                                        Text(conversation.title)
                                            .font(.system(
                                                size: 16,
                                                weight: selected?.id == conversation.id ? .medium : .regular
                                            ))
                                            .lineLimit(1)
                                        Spacer(minLength: 0)
                                    }
                                    .foregroundStyle(AppPalette.text)
                                    .frame(height: 45)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 12)
                    }

                    Rectangle()
                        .fill(AppPalette.border)
                        .frame(height: 0.5)
                    HStack {
                        Button {
                            openDestination(.profile)
                        } label: {
                            Label("账户", systemImage: "person")
                                .font(.system(size: 15, weight: .medium))
                                .frame(minWidth: 72, minHeight: 44, alignment: .leading)
                        }
                        Spacer()
                        Button {
                            openDestination(.settings)
                        } label: {
                            Image(systemName: "gearshape")
                                .font(.system(size: 18))
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("设置")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(AppPalette.text)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 4)
                }
                .frame(width: min(350, geometry.size.width * 0.86))
                .background(AppPalette.background)
                .gesture(
                    DragGesture(minimumDistance: 18)
                        .onEnded { value in
                            guard value.translation.width < -48 else { return }
                            close()
                        }
                )
            }
        }
    }
}

private struct MyChatMark: View {
    var body: some View {
        Text("M")
            .font(.system(size: 18, weight: .bold, design: .rounded))
            .frame(width: 30, height: 30)
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(AppPalette.border, lineWidth: 0.8)
            }
            .accessibilityHidden(true)
    }
}

private struct SidebarAction: View {
    let title: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.system(size: 16, weight: .medium))
                .frame(maxWidth: .infinity, minHeight: 45, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(AppPalette.text)
        .padding(.horizontal, 10)
    }
}

private struct AttachmentActionsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("添加")
                .font(.system(size: 20, weight: .semibold))
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 12)

            AttachmentAction(title: "照片", symbol: "photo") { dismiss() }
            AttachmentAction(title: "拍照", symbol: "camera") { dismiss() }
            AttachmentAction(title: "文件", symbol: "doc") { dismiss() }

            Rectangle()
                .fill(AppPalette.border)
                .frame(height: 0.5)
                .padding(.horizontal, 20)
                .padding(.vertical, 7)

            AttachmentAction(title: "联网", symbol: "globe") { dismiss() }
            AttachmentAction(title: "检索", symbol: "magnifyingglass") { dismiss() }
        }
        .foregroundStyle(AppPalette.text)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(AppPalette.background)
    }
}

private struct AttachmentAction: View {
    let title: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button {
            lightHaptic()
            action()
        } label: {
            Label(title, systemImage: symbol)
                .font(.system(size: 17))
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
    }
}

private struct WorkspaceDestinationView: View {
    let destination: WorkspaceDestination
    let signOut: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if destination == .settings {
                    List {
                        Section {
                            LabeledContent("外观", value: "跟随系统")
                            LabeledContent("客户端", value: "iPhone 原生版")
                        }
                        Section {
                            Button("退出登录", role: .destructive) {
                                dismiss()
                                signOut()
                            }
                        }
                    }
                    .scrollContentBackground(.hidden)
                } else if destination == .profile {
                    List {
                        Section {
                            LabeledContent("账户状态", value: "已登录")
                        }
                    }
                    .scrollContentBackground(.hidden)
                } else {
                    ContentUnavailableView(
                        destination.title,
                        systemImage: destination.symbol,
                        description: Text("这里将直接连接 MyChat 的真实数据。")
                    )
                }
            }
            .background(AppPalette.background)
            .navigationTitle(destination.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                        .foregroundStyle(AppPalette.text)
                }
            }
        }
    }
}

private func lightHaptic() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
}
