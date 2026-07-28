import SwiftUI

@MainActor
final class ChatStore: ObservableObject {
    @Published var conversations: [Conversation] = []
    @Published var selectedConversation: Conversation?
    @Published var messages: [ChatMessage] = []
    @Published var isLoading = false
    @Published var isSending = false
    @Published var error: String?

    private let api = APIClient()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            conversations = try await api.conversations()
            if selectedConversation == nil { selectedConversation = conversations.first }
            if let selectedConversation { try await select(selectedConversation) }
        } catch { self.error = error.localizedDescription }
    }

    func select(_ conversation: Conversation) async throws {
        selectedConversation = conversation
        messages = try await api.messages(conversationID: conversation.id)
    }

    func newConversation() {
        selectedConversation = Conversation(id: UUID(), title: "新对话", updatedAt: nil)
        messages = []
    }

    func send(_ text: String) async {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !isSending else { return }
        if selectedConversation == nil { newConversation() }
        guard let conversation = selectedConversation else { return }
        let snapshot = messages
        let user = ChatMessage(id: UUID(), role: "user", content: prompt, createdAt: Date())
        let assistant = ChatMessage(id: UUID(), role: "assistant", content: "", createdAt: Date())
        messages += [user, assistant]
        isSending = true
        defer { isSending = false }
        do {
            let updates = try await api.send(text: prompt, conversationID: conversation.id, history: snapshot)
            for try await delta in updates {
                guard let last = messages.indices.last else { continue }
                messages[last].content += delta
            }
            messages = try await api.messages(conversationID: conversation.id)
            conversations = try await api.conversations()
            selectedConversation = conversations.first(where: { $0.id == conversation.id }) ?? conversation
        } catch {
            if let last = messages.indices.last { messages[last].content = "生成失败：\(error.localizedDescription)" }
            self.error = error.localizedDescription
        }
    }

    func signOut() { Task { await api.signOut() }; conversations = []; messages = []; selectedConversation = nil }
}

struct RootView: View {
    @State private var signedIn = false

    var body: some View {
        Group {
            if signedIn { ChatView(onSignOut: { signedIn = false }) }
            else { LoginView(onSuccess: { signedIn = true }) }
        }
        .task { signedIn = await APIClient().isSignedIn }
    }
}

struct LoginView: View {
    let onSuccess: () -> Void
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var error: String?
    private let api = APIClient()

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("MyChat").font(.largeTitle.bold())
            Text("登录后继续你的聊天记录").foregroundStyle(.secondary)
            TextField("邮箱", text: $email).textInputAutocapitalization(.never).keyboardType(.emailAddress)
                .textContentType(.username).textFieldStyle(.roundedBorder)
            SecureField("密码", text: $password).textContentType(.password).textFieldStyle(.roundedBorder)
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Button(submitting ? "登录中…" : "登录") {
                Task {
                    submitting = true
                    defer { submitting = false }
                    do { try await api.signIn(email: email, password: password); onSuccess() }
                    catch { self.error = error.localizedDescription }
                }
            }
            .buttonStyle(.borderedProminent).disabled(email.isEmpty || password.isEmpty || submitting)
            Spacer()
        }
        .padding(24)
    }
}

struct ChatView: View {
    let onSignOut: () -> Void
    @StateObject private var store = ChatStore()
    @State private var draft = ""

    var body: some View {
        NavigationSplitView {
            List(selection: $store.selectedConversation) {
                ForEach(store.conversations) { conversation in
                    Text(conversation.title).tag(Optional(conversation))
                }
            }
            .navigationTitle("MyChat")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("退出", action: { store.signOut(); onSignOut() }) }
                ToolbarItem(placement: .topBarTrailing) { Button(action: store.newConversation) { Image(systemName: "square.and.pencil") } }
            }
            .onChange(of: store.selectedConversation) { _, selection in
                guard let selection else { return }
                Task { try? await store.select(selection) }
            }
        } detail: {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(store.messages) { message in MessageBubble(message: message).id(message.id) }
                        }.padding()
                    }
                    .onChange(of: store.messages) { _, value in
                        if let id = value.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                    }
                }
                Divider()
                HStack(alignment: .bottom) {
                    TextField("发消息", text: $draft, axis: .vertical).lineLimit(1...5).textFieldStyle(.roundedBorder)
                    Button(action: { let text = draft; draft = ""; Task { await store.send(text) } }) {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }.disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isSending)
                }.padding()
            }
            .navigationTitle(store.selectedConversation?.title ?? "新对话")
            .overlay { if store.isLoading { ProgressView() } }
            .alert("提示", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
                Button("好", role: .cancel) {}
            } message: { Text(store.error ?? "") }
        }
        .task { await store.load() }
    }
}

struct MessageBubble: View {
    let message: ChatMessage
    var body: some View {
        HStack {
            if message.role == "assistant" { bubble; Spacer(minLength: 42) }
            else { Spacer(minLength: 42); bubble }
        }
    }
    private var bubble: some View {
        Text(message.content.isEmpty && message.role == "assistant" ? "正在思考…" : message.content)
            .textSelection(.enabled).padding(12)
            .background(message.role == "user" ? Color.accentColor : Color(uiColor: .secondarySystemBackground))
            .foregroundStyle(message.role == "user" ? .white : .primary).clipShape(RoundedRectangle(cornerRadius: 16))
    }
}
