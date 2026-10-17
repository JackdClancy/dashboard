// On-screen text reader for fetch-video.mjs (added 2026-10-17).
//
// Reels put most of their substance in text overlays — list items, video
// titles, creator handles, repo names — that a speech transcript never
// hears. This runs macOS's built-in Vision text recognition (local, nothing
// uploaded) over a set of video frames and prints one block per frame:
//
//   ### <filename>
//   line one
//   line two
//
// Usage: ocr-frames <image> [<image> ...]
// fetch-video.mjs compiles this once with swiftc into scripts/.bin/
// (gitignored) and rebuilds it when this file is newer than the binary.

import Foundation
import Vision

let paths = Array(CommandLine.arguments.dropFirst())
if paths.isEmpty {
  FileHandle.standardError.write("usage: ocr-frames <image> [<image> ...]\n".data(using: .utf8)!)
  exit(1)
}

for path in paths {
  let url = URL(fileURLWithPath: path)
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(url: url, options: [:])
  do {
    try handler.perform([request])
  } catch {
    continue
  }
  // Vision returns observations in no guaranteed order; sort top-to-bottom
  // (Vision's y origin is bottom-left), then left-to-right, so overlay lines
  // read in the order a viewer reads them.
  let observations = (request.results ?? []).sorted {
    abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.02
      ? $0.boundingBox.midY > $1.boundingBox.midY
      : $0.boundingBox.minX < $1.boundingBox.minX
  }
  let lines = observations.compactMap { obs -> String? in
    guard let top = obs.topCandidates(1).first, top.confidence >= 0.4 else { return nil }
    return top.string
  }
  print("### \(url.lastPathComponent)")
  for line in lines { print(line) }
  print("")
}
