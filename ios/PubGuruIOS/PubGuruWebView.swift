import SwiftUI
import WebKit

struct PubGuruWebView: UIViewRepresentable {
    private let startURL = URL(string: "https://raw.githack.com/tomk2673/stav-app-ok/pub-guru-v1/pub_guru/start.html")!

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "pubGuruVision")
        controller.add(context.coordinator, name: "pubGuruPhotos")

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.webView = webView
        webView.load(URLRequest(url: startURL, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "pubGuruVision")
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "pubGuruPhotos")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            switch message.name {
            case "pubGuruVision": handleVision(message)
            case "pubGuruPhotos": handlePhotos(message)
            default: break
            }
        }

        private func handleVision(_ message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String,
                  let dataURL = body["imageDataUrl"] as? String,
                  let comma = dataURL.firstIndex(of: ",") else { return }

            let base64 = String(dataURL[dataURL.index(after: comma)...])
            guard let data = Data(base64Encoded: base64) else {
                sendVision(requestId: requestId, error: "Neplatná obrazová data.")
                return
            }

            Task {
                do {
                    let result = try await VisionOCRService.recognize(imageData: data)
                    sendVision(requestId: requestId, result: result)
                } catch {
                    sendVision(requestId: requestId, error: error.localizedDescription)
                }
            }
        }

        private func handlePhotos(_ message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String,
                  let action = body["action"] as? String else { return }

            Task {
                do {
                    switch action {
                    case "listAlbums":
                        let albums = try await InvoicePhotoAlbumService.shared.listAlbums()
                        sendPhotos(["requestId": requestId, "albums": albums])
                    case "syncAlbum":
                        guard let albumId = body["albumId"] as? String else {
                            sendPhotos(["requestId": requestId, "error": "Chybí album faktur."])
                            return
                        }
                        let limit = (body["limit"] as? NSNumber)?.intValue ?? 30
                        let images = try await InvoicePhotoAlbumService.shared.newImages(albumId: albumId, limit: min(max(limit, 1), 50))
                        sendPhotos(["requestId": requestId, "images": images])
                    case "markImported":
                        let ids = body["assetIds"] as? [String] ?? []
                        InvoicePhotoAlbumService.shared.markImported(ids)
                        sendPhotos(["requestId": requestId, "ok": true])
                    default:
                        sendPhotos(["requestId": requestId, "error": "Neznámá operace Fotek."])
                    }
                } catch {
                    sendPhotos(["requestId": requestId, "error": error.localizedDescription])
                }
            }
        }

        private func sendVision(requestId: String, result: VisionOCRResult) {
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
            evaluate(callback: "window.PubGuruNativeOCR && window.PubGuruNativeOCR.resolve", payload: payload)
        }

        private func sendVision(requestId: String, error: String) {
            evaluate(callback: "window.PubGuruNativeOCR && window.PubGuruNativeOCR.resolve", payload: ["requestId": requestId, "error": error])
        }

        private func sendPhotos(_ payload: [String: Any]) {
            evaluate(callback: "window.PubGuruNativePhotos && window.PubGuruNativePhotos.resolve", payload: payload)
        }

        private func evaluate(callback: String, payload: [String: Any]) {
            guard JSONSerialization.isValidJSONObject(payload),
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }

            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript("\(callback)(\(json));")
            }
        }
    }
}
