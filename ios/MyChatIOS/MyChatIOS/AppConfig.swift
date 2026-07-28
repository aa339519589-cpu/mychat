import Foundation

enum AppConfig {
    static var apiBaseURL: URL {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "MYCHAT_API_BASE_URL") as? String,
              let url = URL(string: raw),
              url.scheme == "https" || url.host == "localhost" else {
            fatalError("MYCHAT_API_BASE_URL is missing or invalid. Set it in Configuration/*.xcconfig.")
        }
        return url
    }
}
