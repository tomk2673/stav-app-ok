import SwiftUI
import WebKit

struct PubGuruWebView: UIViewRepresentable {
    private let startURL = PubGuruWebPolicy.startURL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "pubGuruVision")
        controller.add(context.coordinator, name: "pubGuruPhotos")

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.webView = webView
        context.coordinator.start(webView, at: startURL)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.stop()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "pubGuruVision")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "pubGuruPhotos")
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?
        var migration: WebSessionMigration?
        private var navigationID = UUID()
        private var stopped = false

        func start(_ webView: WKWebView, at url: URL) {
            let load: () -> Void = { [weak self, weak webView] in
                guard self?.stopped == false else { return }
                self?.migration = nil
                webView?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
            }
            if UserDefaults.standard.bool(forKey: WebSessionMigration.completedKey) {
                load()
            } else {
                migration = WebSessionMigration(dataStore: webView.configuration.websiteDataStore,
                                                processPool: webView.configuration.processPool, completion: load)
                migration?.start()
            }
        }

        func stop() {
            stopped = true
            migration?.cancel()
            migration = nil
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            navigationID = UUID()
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url, PubGuruWebPolicy.isProduction(url) else {
                decisionHandler(.cancel)
                if navigationAction.navigationType == .linkActivated,
                   let url = navigationAction.request.url, url.scheme == "https" {
                    UIApplication.shared.open(url)
                }
                return
            }
            if navigationAction.targetFrame == nil {
                decisionHandler(.cancel)
                webView.load(navigationAction.request)
            } else {
                decisionHandler(.allow)
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame,
                  origin.protocol == "https", origin.host == PubGuruWebPolicy.startURL.host,
                  origin.port == 0 || origin.port == 443,
                  PubGuruWebPolicy.allowsNativeBridge(message.frameInfo.request.url),
                  PubGuruWebPolicy.allowsNativeBridge(webView?.url) else { return }
            switch message.name {
            case "pubGuruVision": handleVision(message)
            case "pubGuruPhotos": handlePhotos(message)
            default: break
            }
        }

        private func handleVision(_ message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String, requestId.count <= 128 else { return }
            let source = navigationID
            guard let dataURL = body["imageDataUrl"] as? String,
                  dataURL.hasPrefix("data:image/jpeg;base64,"), dataURL.count <= 16 * 1024 * 1024,
                  let comma = dataURL.firstIndex(of: ",") else {
                sendVision(requestId: requestId, error: "Neplatná nebo příliš velká fotografie.", source: source)
                return
            }

            let base64 = String(dataURL[dataURL.index(after: comma)...])
            guard let data = Data(base64Encoded: base64) else {
                sendVision(requestId: requestId, error: "Neplatná obrazová data.", source: source)
                return
            }

            Task {
                do {
                    let result = try await VisionOCRService.recognize(imageData: data)
                    sendVision(requestId: requestId, result: result, source: source)
                } catch {
                    sendVision(requestId: requestId, error: error.localizedDescription, source: source)
                }
            }
        }

        private func handlePhotos(_ message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String, requestId.count <= 128,
                  let action = body["action"] as? String else { return }
            let source = navigationID

            Task {
                do {
                    switch action {
                    case "listAlbums":
                        let albums = try await InvoicePhotoAlbumService.shared.listAlbums()
                        sendPhotos(["requestId": requestId, "albums": albums], source: source)
                    case "syncAlbum":
                        guard let albumId = body["albumId"] as? String else {
                            sendPhotos(["requestId": requestId, "error": "Chybí album faktur."], source: source)
                            return
                        }
                        let limit = (body["limit"] as? NSNumber)?.intValue ?? 30
                        let images = try await InvoicePhotoAlbumService.shared.newImages(albumId: albumId, limit: min(max(limit, 1), 50))
                        sendPhotos(["requestId": requestId, "images": images], source: source)
                    case "markImported":
                        let ids = body["assetIds"] as? [String] ?? []
                        InvoicePhotoAlbumService.shared.markImported(ids)
                        sendPhotos(["requestId": requestId, "ok": true], source: source)
                    default:
                        sendPhotos(["requestId": requestId, "error": "Neznámá operace Fotek."], source: source)
                    }
                } catch {
                    sendPhotos(["requestId": requestId, "error": error.localizedDescription], source: source)
                }
            }
        }

        private func sendVision(requestId: String, result: VisionOCRResult, source: UUID) {
            let payload: [String: Any] = [
                "requestId": requestId,
                "text": result.text,
                "confidence": result.confidence,
                "lines": result.lines.map {
                    [
                        "text": $0.text,
                        "confidence": $0.confidence,
                        "x": $0.x,
                        "y": $0.y,
                        "width": $0.width,
                        "height": $0.height
                    ] as [String: Any]
                }
            ]
            evaluate(callback: "PubGuruNativeOCR", payload: payload, source: source)
        }

        private func sendVision(requestId: String, error: String, source: UUID) {
            evaluate(callback: "PubGuruNativeOCR", payload: ["requestId": requestId, "error": error], source: source)
        }

        private func sendPhotos(_ payload: [String: Any], source: UUID) {
            evaluate(callback: "PubGuruNativePhotos", payload: payload, source: source)
        }

        private func evaluate(callback: String, payload: [String: Any], source: UUID) {
            guard JSONSerialization.isValidJSONObject(payload),
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }

            DispatchQueue.main.async { [weak self] in
                guard let self, source == self.navigationID,
                      PubGuruWebPolicy.allowsNativeBridge(self.webView?.url) else { return }
                self.webView?.evaluateJavaScript("window.\(callback)?.resolve(\(json));")
            }
        }
    }
}
