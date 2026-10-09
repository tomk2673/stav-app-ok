import XCTest
import WebKit
import UIKit
@testable import PubGuru

@MainActor
final class PubGuruIOSTests: XCTestCase {
    func testProductionURLAndBridgeOriginPolicy() {
        XCTAssertEqual(PubGuruWebPolicy.startURL.absoluteString, "https://pub-bizz-pokladna.vercel.app/pub_guru/start.html")
        XCTAssertTrue(PubGuruWebPolicy.allowsNativeBridge(PubGuruWebPolicy.startURL))
        for value in [
            "http://pub-bizz-pokladna.vercel.app/pub_guru/start.html",
            "https://pub-bizz-pokladna.vercel.app.evil.test/pub_guru/start.html",
            "https://pub-bizz-pokladna.vercel.app:8443/pub_guru/start.html",
            "https://user@pub-bizz-pokladna.vercel.app/pub_guru/start.html",
            "https://raw.githack.com/tomk2673/stav-app-ok/pub-guru-v1/pub_guru/start.html",
            "https://pub-bizz-pokladna.vercel.app/pub_bizz_pos/index.html"
        ] { XCTAssertFalse(PubGuruWebPolicy.allowsNativeBridge(URL(string: value)), value) }
    }

    func testImageOrientationMapping() {
        XCTAssertEqual(VisionOCRService.orientation(.up), .up)
        XCTAssertEqual(VisionOCRService.orientation(.right), .right)
        XCTAssertEqual(VisionOCRService.orientation(.left), .left)
        XCTAssertEqual(VisionOCRService.orientation(.down), .down)
        XCTAssertEqual(VisionOCRService.orientation(.upMirrored), .upMirrored)
        XCTAssertEqual(VisionOCRService.orientation(.downMirrored), .downMirrored)
        XCTAssertEqual(VisionOCRService.orientation(.leftMirrored), .leftMirrored)
        XCTAssertEqual(VisionOCRService.orientation(.rightMirrored), .rightMirrored)
    }

    func testVisionRecognizesGeneratedInvoiceWithoutAPI() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1400, height: 900)).image { _ in
            UIColor.white.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: 1400, height: 900))
            let text = "INVOICE 2026\nVodka 2 ks 120.00\nTOTAL 240.00" as NSString
            text.draw(in: CGRect(x: 80, y: 80, width: 1200, height: 700), withAttributes: [
                .font: UIFont.monospacedSystemFont(ofSize: 64, weight: .regular), .foregroundColor: UIColor.black
            ])
        }
        let result = try await VisionOCRService.recognize(imageData: XCTUnwrap(image.jpegData(compressionQuality: 0.94)))
        XCTAssertTrue(result.text.uppercased().contains("INVOICE"), result.text)
        XCTAssertTrue(result.text.contains("240"), result.text)
        XCTAssertFalse(result.lines.isEmpty)
        XCTAssertGreaterThan(result.confidence, 0)
    }

    func testInvalidAndBlankImagesReturnErrors() async {
        do {
            _ = try await VisionOCRService.recognize(imageData: Data("invalid JPEG".utf8))
            XCTFail("Invalid image must fail")
        } catch { XCTAssertTrue(error is VisionOCRError) }
        let blank = UIGraphicsImageRenderer(size: CGSize(width: 500, height: 500)).image { _ in
            UIColor.white.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: 500, height: 500))
        }
        do {
            _ = try await VisionOCRService.recognize(imageData: blank.jpegData(compressionQuality: 1)!)
            XCTFail("Blank image must fail so the JS caller can fall back")
        } catch { XCTAssertTrue(error is VisionOCRError) }
    }

    func testLegacySessionMigrationPreservesOldDataAndCurrentProductionLogin() async throws {
        try await verifyMigration(existingProductionLogin: false)
        try await verifyMigration(existingProductionLogin: true)
    }

    private func verifyMigration(existingProductionLogin: Bool) async throws {
        // Share an isolated store and process pool; no real credentials or network.
        let store = WKWebsiteDataStore.nonPersistent(), pool = WKProcessPool()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.processPool = pool
        let view = WKWebView(frame: .zero, configuration: configuration)
        let loader = LocalHTMLLoader()
        view.navigationDelegate = loader
        let authKey = WebSessionMigration.authKey
        try await loader.load(view, url: PubGuruWebPolicy.legacyOrigin)
        _ = try await view.evaluateJavaScript("""
          localStorage.setItem('\(authKey)', 'legacy-test-session');
          localStorage.setItem('pub_guru_context_v1', 'legacy-test-context');
          localStorage.setItem('pub_guru_invoice_album_id', 'invoice-album');
          localStorage.setItem('unrelated-secret', 'must-stay-local');
          localStorage.setItem('invoice-history-test', 'old-history');
        """)
        if existingProductionLogin {
            try await loader.load(view, url: PubGuruWebPolicy.startURL)
            _ = try await view.evaluateJavaScript("""
              localStorage.setItem('\(authKey)', 'production-test-session');
              localStorage.setItem('pub_guru_context_v1', 'production-test-context');
            """)
        }
        let suite = "PubGuruMigrationTests-\(UUID().uuidString)"
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let done = expectation(description: "Migration completes")
        let migration = WebSessionMigration(dataStore: store, processPool: pool, preferences: preferences) { done.fulfill() }
        migration.start()
        await fulfillment(of: [done], timeout: 12)
        XCTAssertTrue(preferences.bool(forKey: WebSessionMigration.completedKey), "Actual WebKit migration must succeed")
        try await loader.load(view, url: PubGuruWebPolicy.startURL)
        let auth = try await view.evaluateJavaScript("localStorage.getItem('\(authKey)')") as? String
        XCTAssertEqual(auth, existingProductionLogin ? "production-test-session" : "legacy-test-session")
        let context = try await view.evaluateJavaScript("localStorage.getItem('pub_guru_context_v1')") as? String
        XCTAssertEqual(context, existingProductionLogin ? "production-test-context" : "legacy-test-context")
        let album = try await view.evaluateJavaScript("localStorage.getItem('pub_guru_invoice_album_id')") as? String
        XCTAssertEqual(album, "invoice-album")
        let unrelated = try await view.evaluateJavaScript("localStorage.getItem('unrelated-secret')")
        XCTAssertTrue(unrelated is NSNull)
        try await loader.load(view, url: PubGuruWebPolicy.legacyOrigin)
        let oldAuth = try await view.evaluateJavaScript("localStorage.getItem('\(authKey)')") as? String
        XCTAssertEqual(oldAuth, "legacy-test-session")
        let history = try await view.evaluateJavaScript("localStorage.getItem('invoice-history-test')") as? String
        XCTAssertEqual(history, "old-history")
    }
}

@MainActor
private final class LocalHTMLLoader: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?

    func load(_ view: WKWebView, url: URL) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            view.loadHTMLString(WebSessionMigration.blankHTML, baseURL: url)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        continuation?.resume()
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
