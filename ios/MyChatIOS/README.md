# MyChat iOS (phase 1)

Open `MyChatIOS.xcodeproj` in Xcode, select your iPhone as the run target, set
your Apple development team under **Signing & Capabilities**, then Run.

The first build points to the currently configured MyChat server in
`Configuration/Debug.xcconfig`. For a different environment, change only
`MYCHAT_API_BASE_URL` to its HTTPS base URL. The app downloads the public
Supabase bootstrap config from `/api/mobile/config`; it never contains a
service-role key.

Implemented scope: email/password login, existing conversation list and
history, new text chats, durable server-side enqueue, and native SSE rendering
of AI output. It is a SwiftUI client, not a WebView wrapper.
