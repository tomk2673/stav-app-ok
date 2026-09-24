import Foundation
import Photos
import UIKit

final class InvoicePhotoAlbumService {
    static let shared = InvoicePhotoAlbumService()

    private let importedKey = "pubGuruImportedInvoicePhotoAssetIds"
    private init() {}

    func listAlbums() async throws -> [[String: Any]] {
        try await ensureAccess()
        let result = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        var albums: [[String: Any]] = []
        result.enumerateObjects { collection, _, _ in
            let title = collection.localizedTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !title.isEmpty else { return }
            albums.append([
                "id": collection.localIdentifier,
                "title": title,
                "shared": collection.assetCollectionSubtype == .albumCloudShared
            ])
        }
        return albums.sorted {
            let leftShared = ($0["shared"] as? Bool) == true
            let rightShared = ($1["shared"] as? Bool) == true
            if leftShared != rightShared { return leftShared && !rightShared }
            return (($0["title"] as? String) ?? "") < (($1["title"] as? String) ?? "")
        }
    }

    func newImages(albumId: String, limit: Int = 30) async throws -> [[String: Any]] {
        try await ensureAccess()
        let collections = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumId], options: nil)
        guard let album = collections.firstObject else { throw AlbumError.albumNotFound }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        let assets = PHAsset.fetchAssets(in: album, options: options)
        let imported = importedIds()

        var candidates: [PHAsset] = []
        assets.enumerateObjects { asset, _, _ in
            if !imported.contains(asset.localIdentifier) { candidates.append(asset) }
        }
        if candidates.count > limit { candidates = Array(candidates.suffix(limit)) }

        var output: [[String: Any]] = []
        for asset in candidates {
            let data = try await jpegData(for: asset)
            let stamp = asset.creationDate.map { Self.fileDateFormatter.string(from: $0) } ?? UUID().uuidString
            output.append([
                "assetId": asset.localIdentifier,
                "name": "faktura-\(stamp).jpg",
                "dataUrl": "data:image/jpeg;base64,\(data.base64EncodedString())"
            ])
        }
        return output
    }

    func markImported(_ assetIds: [String]) {
        guard !assetIds.isEmpty else { return }
        var values = Array(importedIds())
        values.append(contentsOf: assetIds)
        var unique: [String] = []
        var seen = Set<String>()
        for id in values.reversed() where seen.insert(id).inserted {
            unique.append(id)
            if unique.count >= 2000 { break }
        }
        UserDefaults.standard.set(Array(unique.reversed()), forKey: importedKey)
    }

    private func importedIds() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: importedKey) ?? [])
    }

    private func ensureAccess() async throws {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if current == .authorized || current == .limited { return }
        if current == .denied || current == .restricted { throw AlbumError.accessDenied }
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        guard status == .authorized || status == .limited else { throw AlbumError.accessDenied }
    }

    private func jpegData(for asset: PHAsset) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let options = PHImageRequestOptions()
            options.isNetworkAccessAllowed = true
            options.deliveryMode = .highQualityFormat
            options.resizeMode = .fast
            let target = CGSize(width: 2200, height: 2200)
            PHImageManager.default().requestImage(
                for: asset,
                targetSize: target,
                contentMode: .aspectFit,
                options: options
            ) { image, info in
                if let cancelled = info?[PHImageCancelledKey] as? Bool, cancelled {
                    continuation.resume(throwing: AlbumError.imageUnavailable)
                    return
                }
                if let error = info?[PHImageErrorKey] as? Error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let image, let data = image.jpegData(compressionQuality: 0.78) else {
                    continuation.resume(throwing: AlbumError.imageUnavailable)
                    return
                }
                continuation.resume(returning: data)
            }
        }
    }

    private static let fileDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()

    enum AlbumError: LocalizedError {
        case accessDenied
        case albumNotFound
        case imageUnavailable

        var errorDescription: String? {
            switch self {
            case .accessDenied: return "PUB GURU nemá povolený přístup k Fotkám."
            case .albumNotFound: return "Vybrané album faktur už není dostupné."
            case .imageUnavailable: return "Fotografii z iCloudu se nepodařilo načíst."
            }
        }
    }
}
