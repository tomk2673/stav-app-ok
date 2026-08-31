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
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "pubGuruVision",
                  let body = message.body as? [String: Any],
                  let requestId = body["requestId"] as? String,
                  let dataURL = body["imageDataUrl"] as? String,
                  let comma = dataURL.firstIndex(of: ",") else {
                return
            }

            let base64 = String(dataURL[dataURL.index(after: comma)...])
            guard let data = Data(base64Encoded: base64) else {
                send(requestId: requestId, error: "Neplatná obrazová data.")
                return
            }

            Task {
                do {
                    let result = try await VisionOCRService.recognize(imageData: data)
                    send(requestId: requestId, result: result)
                } catch {
                    send(requestId: requestId, error: error.localizedDescription)
                }
            }
        }

        private func send(requestId: String, result: VisionOCRResult) {
            var payload: [String: Any] = [
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
            evaluate(payload)
        }

        private func send(requestId: String, error: String) {
            evaluate(["requestId": requestId, "error": error])
        }

        private func evaluate(_ payload: [String: Any]) {
            guard JSONSerialization.isValidJSONObject(payload),
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }

            DispatchQueue.main.async { [weak self] in
                self?.webView?.evaluateJavaScript("window.PubGuruNativeOCR && window.PubGuruNativeOCR.resolve(\(json));")
            }
        }
    }
}
