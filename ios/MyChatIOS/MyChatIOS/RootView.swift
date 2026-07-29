import SwiftUI

enum AppPalette {
    static let background = Color(red: 0.988, green: 0.978, blue: 0.952)
    static let surface = Color.white
    static let mutedSurface = Color(red: 0.944, green: 0.937, blue: 0.918)
    static let border = Color.black.opacity(0.09)
    static let text = Color(red: 0.08, green: 0.075, blue: 0.065)
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
            if !models.contains(selectedModel) {
                selectedModel = models.first ?? ModelChoice.platform[1]
            }
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
                    if event.kind == "job.warning", let message = event.payload["message"]?.string {
                        error = message
                    }
                    if event.kind == "job.terminal",
                       let status = event.payload["status"]?.string,
                       status != "completed" {
                        throw APIError.message(event.payload["error"]?.string ?? "生成未完成")
                    }
                }
                try await refresh(conversationID: conversation.id)
            } catch is CancellationError {
                return
            } catch {
                replaceEmptyAssistant(assistantID, with: "发送失败")
                failedMessageID = assistantID
                retryContext = RetryContext(text: text, userID: userID, assistantID: assistantID)
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
                    selectModel: { store.selectedModel = $0 },
                    newConversation: store.newConversation
                )
                if store.messages.isEmpty {
                    WelcomeHome()
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
                    newConversation: store.newConversation,
                    send: {
                        let value = draft
                        draft = ""
                        store.send(value)
                    },
                    reportError: { store.error = $0 }
                )
            }
            .disabled(sidebarVisible)

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
                    signOut: onSignOut
                )
                .transition(.opacity)
                .zIndex(2)
            }
        }
        .animation(.easeOut(duration: 0.18), value: sidebarVisible)
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

struct WelcomeHome: View {
    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image("companion")
                .resizable()
                .interpolation(.none)
                .scaledToFit()
                .frame(width: 76, height: 76)
                .accessibilityHidden(true)
            Text("欢迎回来")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(AppPalette.text)
            Spacer()
                .frame(height: 170)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
    let failed: Bool
    let retry: () -> Void

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
                    Text(displayText)
                        .font(.system(size: 17))
                        .lineSpacing(5)
                        .textSelection(.enabled)
                        .foregroundStyle(AppPalette.text)
                        .fixedSize(horizontal: false, vertical: true)
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
        if message.role == "assistant", message.content.isEmpty { return "正在思考…" }
        return message.content
    }
}

struct Composer: View {
    @Binding var draft: String
    let isFocused: FocusState<Bool>.Binding
    let isSending: Bool
    let newConversation: () -> Void
    let send: () -> Void
    let reportError: (String) -> Void
    @StateObject private var speech = SpeechInput()

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            Button(action: newConversation) {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .regular))
                    .frame(width: 40, height: 40)
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(AppPalette.border, lineWidth: 0.7)
                    }
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("新对话")

            TextField("发消息", text: $draft, axis: .vertical)
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
                    .frame(width: 40, height: 40)
                    .background(actionBackground)
                    .clipShape(Circle())
            }
            .disabled(isSending)
            .accessibilityLabel(draftIsEmpty ? (speech.isRecording ? "停止听写" : "语音输入") : "发送")
        }
        .padding(6)
        .background(AppPalette.surface)
        .overlay {
            RoundedRectangle(cornerRadius: 19, style: .continuous)
                .stroke(AppPalette.border, lineWidth: 0.7)
        }
        .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
        .shadow(color: .black.opacity(0.07), radius: 9, x: 0, y: 3)
        .padding(.horizontal, 14)
        .padding(.top, 7)
        .padding(.bottom, 8)
        .background(AppPalette.background)
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
        return speech.isRecording ? "stop.fill" : "waveform"
    }

    private var actionForeground: Color {
        if !draftIsEmpty { return Color(uiColor: .systemBackground) }
        return .primary
    }

    private var actionBackground: Color {
        if !draftIsEmpty { return .primary }
        return AppPalette.mutedSurface
    }

    private func primaryAction() {
        if draftIsEmpty {
            Task { await speech.toggle() }
        } else {
            speech.stop()
            send()
        }
    }
}

struct SidebarOverlay: View {
    let conversations: [Conversation]
    let selected: Conversation?
    let close: () -> Void
    let select: (Conversation) -> Void
    let newConversation: () -> Void
    let signOut: () -> Void

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Color.black.opacity(0.18)
                    .ignoresSafeArea()
                    .onTapGesture(perform: close)
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("对话")
                            .font(.title2.weight(.semibold))
                        Spacer()
                        Button(action: newConversation) {
                            Image(systemName: "square.and.pencil")
                                .frame(width: 44, height: 44)
                        }
                        .accessibilityLabel("新对话")
                    }
                    .padding(.leading, 20)
                    .padding(.trailing, 8)
                    .frame(height: 56)

                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(conversations) { conversation in
                                Button {
                                    select(conversation)
                                } label: {
                                    Text(conversation.title)
                                        .font(.system(size: 16))
                                        .lineLimit(1)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 14)
                                        .frame(height: 46)
                                        .background(
                                            selected?.id == conversation.id
                                                ? AppPalette.mutedSurface
                                                : .clear
                                        )
                                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 8)
                    }

                    Divider()
                    Button(action: signOut) {
                        Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(height: 50)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
                }
                .frame(width: min(332, geometry.size.width * 0.86))
                .background(AppPalette.background)
                .ignoresSafeArea(edges: .bottom)
            }
        }
    }
}
