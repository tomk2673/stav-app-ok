import Foundation
import UIKit
import Vision

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

enum VisionOCRError: Error {
    case invalidImage
}

final class VisionOCRService {
    static func recognize(imageData: Data) async throws -> VisionOCRResult {
        guard let image = UIImage(data: imageData), let cgImage = image.cgImage else {
            throw VisionOCRError.invalidImage
        }

        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }

                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
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
                let confidence = lines.isEmpty ? 0 : lines.reduce(0) { $0 + $1.confidence } / Float(lines.count)
                continuation.resume(returning: VisionOCRResult(text: text, confidence: confidence, lines: lines))
            }

            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["cs-CZ", "en-US"]
            request.minimumTextHeight = 0.006

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try handler.perform([request])
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}
