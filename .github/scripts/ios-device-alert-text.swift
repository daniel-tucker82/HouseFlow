import Foundation
import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import Vision

let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 4 else { exit(2) }
func normalized(_ text: String) -> String {
    text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
}
let title = normalized(args[0])
func showsTitle(_ handler: VNImageRequestHandler) throws -> Bool {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    request.regionOfInterest = CGRect(x: 0, y: 0.60, width: 1, height: 0.40)
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return normalized(lines.joined(separator: " ")).contains(title)
}
guard try !showsTitle(VNImageRequestHandler(url: URL(fileURLWithPath: args[1]), options: [:])) else { exit(3) }
let asset = AVURLAsset(url: URL(fileURLWithPath: args[2]))
let length = try await asset.load(.duration)
let duration = length.seconds
guard duration.isFinite, duration >= 2, duration <= 75 else { exit(4) }
let frames = AVAssetImageGenerator(asset: asset)
frames.appliesPreferredTrackTransform = true
frames.requestedTimeToleranceAfter = CMTime(seconds: 0.12, preferredTimescale: 600)
frames.requestedTimeToleranceBefore = frames.requestedTimeToleranceAfter
var matches: [String] = []
for seconds in stride(from: 0.1, to: duration - 0.1, by: 0.25) {
    let frame = try await frames.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
    let found = try autoreleasepool { try showsTitle(VNImageRequestHandler(cgImage: frame.image, options: [:])) }
    if found {
        let name = "banner-\(Int(frame.actualTime.seconds * 1000))ms.png"
        let file = URL(fileURLWithPath: args[3]).appendingPathComponent(name)
        guard let dest = CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(5) }
        CGImageDestinationAddImage(dest, frame.image, nil)
        guard CGImageDestinationFinalize(dest) else { exit(5) }
        matches.append(name)
        break
    }
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: matches))
