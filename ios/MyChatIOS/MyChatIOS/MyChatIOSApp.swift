import SwiftUI

@main
struct MyChatIOSApp: App {
    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.arguments.contains("-RichRendererPreview")
                || ProcessInfo.processInfo.environment["RICH_RENDERER_PREVIEW"] == "1" {
                RichRendererPreview()
            } else {
                RootView()
            }
        }
    }
}
