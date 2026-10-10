import Foundation
import WebKit

// Reads ONLY this application's keys through a bundled, inert HTML document.
// No legacy remote app, URL query tokens, cookies from other sites or stored
// invoices are loaded, transferred, removed or logged.
@MainActor
final class WebSessionMigration: NSObject, WKNavigationDelegate {
    static let completedKey = "pubGuruProductionSessionMigrationV1"
    static let authKey = "sb-gnfqlfxuagcgjztaueot-auth-token"
    static let keys = [authKey, "pub_guru_context_v1", "pub_guru_invoice_album_id"]
    static let blankHTML = "<!doctype html><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'\"><title>PUB INVOICES</title>"

    private let preferences: UserDefaults
    private let completion: () -> Void
    private var view: WKWebView?
    private var values: [String: String] = [:]
    private var readingLegacy = true
    private var timeout: DispatchWorkItem?
    private var finished = false

    init(dataStore: WKWebsiteDataStore, processPool: WKProcessPool,
         preferences: UserDefaults = .standard, completion: @escaping () -> Void) {
        self.preferences = preferences
        self.completion = completion
        super.init()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.processPool = processPool
        view = WKWebView(frame: .zero, configuration: configuration)
        view?.navigationDelegate = self
    }

    func start() {
        let item = DispatchWorkItem { [weak self] in self?.finish(success: false) }
        timeout = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: item)
        view?.loadHTMLString(Self.blankHTML, baseURL: PubGuruWebPolicy.legacyOrigin)
    }

    func cancel() { finish(success: false) }

    static var readScript: String {
        let keysJSON = String(data: try! JSONSerialization.data(withJSONObject: keys), encoding: .utf8)!
        return """
        (() => {
          if (location.origin !== 'https://raw.githack.com') throw new Error('Unexpected origin');
          const result = {};
          for (const key of \(keysJSON)) {
            const value = localStorage.getItem(key);
            if (value !== null && value.length < 65536) result[key] = value;
          }
          return result;
        })()
        """
    }

    static func restoreScript(_ values: [String: String]) -> String {
        let filtered = values.filter { keys.contains($0.key) && $0.value.count < 65536 }
        let json = String(data: try! JSONSerialization.data(withJSONObject: filtered), encoding: .utf8)!
        return """
        (() => {
          if (location.origin !== '\(PubGuruWebPolicy.startURL.scheme!)://\(PubGuruWebPolicy.startURL.host!)') throw new Error('Unexpected origin');
          const values = \(json);
          // Never replace an existing production login or its tenant context.
          if (!localStorage.getItem('\(authKey)') && values['\(authKey)']) {
            localStorage.setItem('\(authKey)', values['\(authKey)']);
            if (values.pub_guru_context_v1) localStorage.setItem('pub_guru_context_v1', values.pub_guru_context_v1);
          }
          if (!localStorage.getItem('pub_guru_invoice_album_id') && values.pub_guru_invoice_album_id) {
            localStorage.setItem('pub_guru_invoice_album_id', values.pub_guru_invoice_album_id);
          }
          return true;
        })()
        """
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !finished else { return }
        if readingLegacy {
            webView.evaluateJavaScript(Self.readScript) { [weak self] result, error in
                guard let self, !self.finished else { return }
                guard error == nil, let values = result as? [String: String] else {
                    self.finish(success: false)
                    return
                }
                self.values = values
                self.readingLegacy = false
                webView.loadHTMLString(Self.blankHTML, baseURL: PubGuruWebPolicy.startURL)
            }
        } else {
            webView.evaluateJavaScript(Self.restoreScript(values)) { [weak self] _, error in
                self?.finish(success: error == nil)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(success: false) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(success: false) }

    private func finish(success: Bool) {
        guard !finished else { return }
        finished = true
        timeout?.cancel()
        view?.stopLoading()
        view?.navigationDelegate = nil
        view = nil
        values = [:]
        if success { preferences.set(true, forKey: Self.completedKey) }
        completion()
    }
}
