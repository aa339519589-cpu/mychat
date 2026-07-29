import SwiftUI

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
                    .background(Color(uiColor: .systemBackground))
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
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
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
    @Published var conversations: [Conversation] = []
    @Published var selectedConversation: Conversation?
    @Published var messages: [ChatMessage] = []
    @Published var models: [ModelChoice] = ModelChoice.platform
    @Published var selectedModel: ModelChoice = ModelChoice.platform[1]
    @Published var isLoading = true
    @Published var isSending = false
    @Published var error: String?

    private let api: APIClient
    private var streamTask: Task<Void, Never>?

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
        selectedConversation = conversation
        messages = try await api.messages(conversationID: conversation.id)
    }

    func newConversation() {
        streamTask?.cancel()
        selectedConversation = Conversation(id: UUID(), title: "新对话", updatedAt: nil)
        messages = []
        isSending = false
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
                replaceEmptyAssistant(assistantID, with: "发送失败：\(error.localizedDescription)")
                self.error = error.localizedDescription
            }
        }
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
            Color(uiColor: .systemBackground).ignoresSafeArea()
            VStack(spacing: 0) {
                ChatTopBar(
                    models: store.models,
                    selected: store.selectedModel,
                    openSidebar: { sidebarVisible = true },
                    selectModel: { store.selectedModel = $0 },
                    newConversation: store.newConversation
                )
                MessageList(messages: store.messages, isSending: store.isSending)
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
        .overlay {
            if store.isLoading {
                ProgressView()
                    .controlSize(.regular)
            }
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
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .frame(height: 54)
    }
}

struct MessageList: View {
    let messages: [ChatMessage]
    let isSending: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(messages) { message in
                        NativeMessageRow(message: message)
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

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == "user" { Spacer(minLength: 52) }
            Text(displayText)
                .font(.system(size: 17))
                .lineSpacing(4)
                .textSelection(.enabled)
                .foregroundStyle(.primary)
                .padding(.horizontal, message.role == "user" ? 14 : 0)
                .padding(.vertical, message.role == "user" ? 10 : 0)
                .background {
                    if message.role == "user" {
                        Color(uiColor: .secondarySystemBackground)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            if message.role != "user" { Spacer(minLength: 28) }
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
            Menu {
                Button(action: newConversation) {
                    Label("新对话", systemImage: "square.and.pencil")
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 21, weight: .regular))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("更多")

            TextField("发消息", text: $draft, axis: .vertical)
                .font(.system(size: 17))
                .lineLimit(1...6)
                .focused(isFocused)
                .padding(.horizontal, 4)
                .padding(.vertical, 11)
                .disabled(isSending)

            Button(action: primaryAction) {
                Image(systemName: actionIcon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(actionForeground)
                    .frame(width: 44, height: 44)
                    .background(actionBackground)
                    .clipShape(Circle())
            }
            .disabled(isSending)
            .accessibilityLabel(draftIsEmpty ? (speech.isRecording ? "停止听写" : "语音输入") : "发送")
        }
        .padding(6)
        .background(Color(uiColor: .secondarySystemBackground))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
        }
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 7)
        .background(Color(uiColor: .systemBackground))
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
        return Color(uiColor: .tertiarySystemFill)
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
                                                ? Color(uiColor: .secondarySystemBackground)
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
                .background(Color(uiColor: .systemBackground))
                .ignoresSafeArea(edges: .bottom)
            }
        }
    }
}
