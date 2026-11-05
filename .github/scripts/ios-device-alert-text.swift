import Foundation
import Vision

// Inspect only the banner region of a simulator screen. Never retain OCR text;
// report the filenames that displayed the unique title before opening the pane.
let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 3 else { exit(2) }
func normalized(_ text: String) -> String {
    text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
}
let title = normalized(args[0])
func showsTitle(_ path: String) throws -> Bool {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    request.regionOfInterest = CGRect(x: 0, y: 0.60, width: 1, height: 0.40)
    try VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:]).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return normalized(lines.joined(separator: " ")).contains(title)
}
let wasAlreadyVisible = try showsTitle(args[1])
guard !wasAlreadyVisible else { exit(3) }
let matches = try args.dropFirst(2).filter { try showsTitle($0) }
let data = try JSONSerialization.data(withJSONObject: matches.map { URL(fileURLWithPath: $0).lastPathComponent })
FileHandle.standardOutput.write(data)
