import Foundation
import UIKit
import Vision
import ImageIO

struct VisionOCRLine: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct VisionOCRResult: Codable {
    let text: String
    let confidence: Float
    let lines: [VisionOCRLine]
}

enum VisionOCRError: LocalizedError {
    case invalidImage
    case noText

    var errorDescription: String? {
        switch self {
        case .invalidImage: return "Fotografii se nepodařilo dekódovat."
        case .noText: return "Apple Vision nerozpoznalo žádný text."
        }
    }
}

final class VisionOCRService {
    static func recognize(imageData: Data) async throws -> VisionOCRResult {
        // A single throwing task avoids resuming a continuation twice when
        // Vision reports an error from both perform() and a completion handler.
        return try await Task.detached(priority: .userInitiated) {
            guard let image = UIImage(data: imageData), let cgImage = image.cgImage else {
                throw VisionOCRError.invalidImage
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            let supported = try request.supportedRecognitionLanguages()
            let preferred = ["cs-CZ", "en-US"].filter { supported.contains($0) }
            if !preferred.isEmpty { request.recognitionLanguages = preferred }
            request.minimumTextHeight = 0.006
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation(image.imageOrientation), options: [:])
            try handler.perform([request])

            let observations = request.results ?? []
            let sorted = observations.sorted { lhs, rhs in
                let ly = lhs.boundingBox.maxY
                let ry = rhs.boundingBox.maxY
                if abs(ly - ry) > 0.02 { return ly > ry }
                return lhs.boundingBox.minX < rhs.boundingBox.minX
            }

            let lines: [VisionOCRLine] = sorted.compactMap { observation in
                guard let best = observation.topCandidates(1).first else { return nil }
                let b = observation.boundingBox
                return VisionOCRLine(
                    text: best.string,
                    confidence: best.confidence,
                    x: b.minX,
                    y: b.minY,
                    width: b.width,
                    height: b.height
                )
            }

            let text = lines.map(\.text).joined(separator: "\n")
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw VisionOCRError.noText }
            let confidence = lines.isEmpty ? 0 : lines.reduce(0) { $0 + $1.confidence } / Float(lines.count)
            return VisionOCRResult(text: text, confidence: confidence, lines: lines)
        }.value
    }

    static func orientation(_ orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}
