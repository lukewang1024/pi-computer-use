import Foundation

// Diagnostic evidence only: never derive input permission from a document URL.
func accessibilityDocumentURL(_ value: Any?) -> String? {
    guard let text = value as? String, !text.isEmpty, text.utf8.count <= 4096,
          !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
          let url = URL(string: text), url.isFileURL,
          url.host == nil || url.host == "" || url.host == "localhost",
          url.user == nil, url.password == nil, url.port == nil,
          url.query == nil, url.fragment == nil, url.path.hasPrefix("/") else { return nil }
    return url.absoluteString
}
