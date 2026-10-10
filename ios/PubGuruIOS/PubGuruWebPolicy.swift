import Foundation

enum PubGuruWebPolicy {
    // Stable production alias, verified against the main deployment on 2026-10-09.
    static let startURL = URL(string: "https://pub-bizz-pokladna.vercel.app/pub_guru/start.html")!
    static let legacyOrigin = URL(string: "https://raw.githack.com/")!

    static func isProduction(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host == startURL.host &&
            (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }

    static func allowsNativeBridge(_ url: URL?) -> Bool {
        isProduction(url) && (url?.path.hasPrefix("/pub_guru/") == true)
    }
}
