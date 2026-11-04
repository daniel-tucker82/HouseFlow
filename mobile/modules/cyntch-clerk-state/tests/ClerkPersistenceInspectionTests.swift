import Foundation

// Compile with the production inspector on a Mac. These fixtures test parsing
// and privacy verdicts; they never read or modify a real Keychain item.
@main
struct ClerkPersistenceInspectionTests {
  private enum Failure: Error { case assertion(String) }

  private static func expect(_ condition: Bool, _ message: String) throws {
    guard condition else { throw Failure.assertion(message) }
  }

  private static func inspect(_ value: Any, accountId: String = "user_deleted") throws -> ClerkPersistenceVerdict {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
    return try ClerkPersistenceInspection.inspect(data: data, accountId: accountId)
  }

  private static func client(_ sessions: [[String: Any]] = []) -> [String: Any] {
    ["id": "client_fixture", "sessions": sessions, "updated_at": 1_793_779_200_000]
  }

  private static func session(_ userId: String) -> [String: Any] {
    ["id": "sess_fixture", "user": ["id": userId]]
  }

  private static func rejects(_ value: Any) throws {
    var rejected = false
    do { _ = try inspect(value) } catch { rejected = true }
    try expect(rejected, "An unsupported cache must not establish cleanup")
  }

  static func main() throws {
    let tests: [(String, () throws -> Void)] = [
      ("empty known client can establish absence", {
        let verdict = try inspect(client())
        try expect(verdict.ready && !verdict.hasAccount && !verdict.hasUnidentifiedSession && !verdict.hasAuthenticationSnapshot,
                   "Empty known client was not recognized")
      }),
      ("legacy client and current wrapper both detect the deleted account", {
        let value = client([session("user_deleted")])
        let snapshots: [Any] = [value, ["client": value, "serverDate": 1_793_779_200_000]]
        for snapshot in snapshots {
          let verdict = try inspect(snapshot)
          try expect(verdict.ready && verdict.hasAccount && !verdict.hasUnidentifiedSession,
                     "Deleted account was missed")
        }
      }),
      ("another identified account is not the deleted account", {
        let verdict = try inspect(client([session("user_other")]))
        try expect(verdict.ready && !verdict.hasAccount && !verdict.hasUnidentifiedSession,
                   "Another account was mistaken for deleted or unidentified data")
      }),
      ("mixed sessions retain both privacy warnings", {
        let verdict = try inspect(client([session("user_other"), session("user_deleted"), ["id": "sess_unknown"]]))
        try expect(verdict.hasAccount && verdict.hasUnidentifiedSession, "Mixed sessions lost a privacy warning")
      }),
      ("missing and malformed user identities stay unverified", {
        let users: [Any] = [NSNull(), "invalid", [:] as [String: Any], ["id": 42], ["id": ""], ["id": "user_"], ["id": "other_123"], ["id": "user_" + String(repeating: "x", count: 201)]]
        for user in users {
          let verdict = try inspect(client([["id": "sess_fixture", "user": user]]))
          try expect(verdict.hasUnidentifiedSession, "An ambiguous session was treated as erased")
        }
      }),
      ("sign-in and sign-up attempts block a clean verdict", {
        for key in ["sign_in", "sign_up"] {
          var value = client()
          value[key] = ["id": "pending_attempt", "identifier": "private@example.invalid"]
          try expect(try inspect(value).hasAuthenticationSnapshot, "Authentication attempt was missed")
          value[key] = [:] as [String: Any]
          try expect(try inspect(value).hasAuthenticationSnapshot, "Empty authentication object was treated as absent")
          value[key] = NSNull()
          try expect(!(try inspect(value)).hasAuthenticationSnapshot, "Null authentication attempt was treated as present")
        }
      }),
      ("unknown client schema is rejected", {
        var value = client()
        value["future_account_cache"] = ["id": "user_deleted"]
        try rejects(value)
      }),
      ("malformed roots and session lists are rejected", {
        let values: [Any] = [NSNull(), [] as [Any], "invalid", [:] as [String: Any], ["client": NSNull()],
                           ["id": "client_fixture"], ["id": 42, "sessions": [] as [Any]],
                           ["id": "client_fixture", "sessions": NSNull()],
                           ["id": "client_fixture", "sessions": ["invalid"]]]
        for value in values {
          try rejects(value)
        }
      }),
      ("invalid JSON is rejected", {
        var rejected = false
        do { _ = try ClerkPersistenceInspection.inspect(data: Data("{incomplete".utf8), accountId: "user_deleted") }
        catch { rejected = true }
        try expect(rejected, "Corrupt JSON was treated as erased")
      }),
      ("bridge payload contains verdicts only", {
        var value = client([["id": "sess_private", "user": ["id": "user_deleted", "email": "private@example.invalid"], "last_active_token": "private-token"]])
        value["sign_in"] = ["id": "attempt_private"]
        let payload = try inspect(value).payload
        try expect(Set(payload.keys) == Set(["format", "ready", "hasAccount", "hasUnidentifiedSession", "hasAuthenticationSnapshot"]),
                   "Bridge payload includes unexpected fields")
        let json = String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
        try expect(!json.contains("private") && !json.contains("user_deleted"), "Private cache contents escaped the inspector")
      })
    ]
    for (name, run) in tests {
      try run()
      print("PASS: \(name)")
    }
    print("Passed \(tests.count) native Clerk persistence checks")
  }
}
