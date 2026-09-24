import SwiftUI

@main
struct PubGuruApp: App {
    var body: some Scene {
        WindowGroup {
            PubGuruWebView()
                .ignoresSafeArea()
        }
    }
}
