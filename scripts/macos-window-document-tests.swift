import Foundation
@main struct Tests {
    static func main() {
        precondition(accessibilityDocumentURL("file:///Users/test/fixture.docx") == "file:///Users/test/fixture.docx")
        precondition(accessibilityDocumentURL("file:///tmp/%E4%B8%AD%E6%96%87.docx") != nil)
        let unavailable: [Any?] = [nil, 42, "", "relative.docx", "https://example.test/token", "file://other-host/tmp/a", "file:///tmp/a?token=secret", "file:///tmp/a#secret", "file://user:password@localhost/tmp/a", "file:///tmp/a\n", String(repeating: "a", count: 4097)]
        for value in unavailable { precondition(accessibilityDocumentURL(value) == nil) }
        print("PASS bounded local AX document URL evidence")
    }
}
