import Foundation

// Exercises the production erasure coordinator with an interruptible store.
// These checks do not enroll biometrics or establish iOS Keychain behavior.
@main
struct ClerkBiometricCleanupTests {
  enum Failure: Error { case assertion(String), injected }
  static let app = "com.cyntch.fixture"
  static let deletedKey = "tdlk_" + String(repeating: "a", count: 32)
  static let otherKey = "tdlk_" + String(repeating: "b", count: 32)
  static let secondKey = "tdlk_" + String(repeating: "c", count: 32)

  static func expect(_ value: Bool, _ message: String) throws {
    if !value { throw Failure.assertion(message) }
  }
  static func data(_ records: [[String: Any]]) throws -> Data {
    try JSONSerialization.data(withJSONObject: records, options: [.sortedKeys])
  }
  static func record(_ id: String = "credential_deleted", user: String = "user_deleted", key: String = deletedKey, appId: String = app) -> [String: Any] {
    ["id": id, "localKeyId": key, "userId": user, "appIdentifier": appId,
     "identifierHint": "private@example.invalid", "policy": "biometry_current_set",
     "createdAt": 1_793_779_200_000, "updatedAt": 1_793_779_200_000]
  }

  @MainActor
  final class Store: ClerkBiometricStorage {
    var snapshot: ClerkBiometricSnapshot?
    var keys: Set<String>
    var removed: [String] = []
    var replacements = 0
    var failKey: String?
    var failWrite = false
    var keepKey = false
    var afterRemove: (() throws -> Void)?
    init(_ records: [[String: Any]]?, keys: Set<String> = []) throws {
      snapshot = try records.map { ClerkBiometricSnapshot(reference: Data("fixture".utf8), data: try ClerkBiometricCleanupTests.data($0)) }
      self.keys = keys
    }
    func read() throws -> ClerkBiometricSnapshot? { snapshot }
    func removeKey(_ localKeyId: String) throws {
      if localKeyId == failKey { throw Failure.injected }
      removed.append(localKeyId)
      if !keepKey { keys.remove(localKeyId) }
      try afterRemove?()
    }
    func hasKey(_ localKeyId: String) throws -> Bool { keys.contains(localKeyId) }
    func replace(_ original: ClerkBiometricSnapshot, with value: Data?) throws {
      if failWrite { throw Failure.injected }
      try ClerkBiometricCleanupTests.expect(original == snapshot, "A stale metadata write was attempted")
      replacements += 1
      snapshot = value.map { ClerkBiometricSnapshot(reference: original.reference, data: $0) }
    }
    func erase() throws -> Int {
      try ClerkBiometricCleanup.erase(accountId: "user_deleted", appIdentifier: ClerkBiometricCleanupTests.app, storage: self)
    }
  }

  @MainActor
  static func rejects(_ store: Store) throws {
    var rejected = false
    do { _ = try store.erase() } catch { rejected = true }
    try expect(rejected, "Ambiguous or incomplete cleanup was reported as complete")
  }

  @MainActor
  static func main() throws {
    let tests: [(String, @MainActor () throws -> Void)] = [
      ("absent metadata needs no write", {
        let store = try Store(nil)
        try expect(try store.erase() == 0 && store.replacements == 0, "Empty storage was modified")
      }),
      ("remove only the deleted account and preserve another member", {
        let other = record("credential_other", user: "user_other", key: otherKey)
        let store = try Store([record(), other], keys: [deletedKey, otherKey])
        try expect(try store.erase() == 1, "Incorrect removal count")
        try expect(store.keys == [otherKey] && store.removed == [deletedKey], "Wrong private keys were removed")
        try expect(store.snapshot?.data == (try data([other])), "Other member metadata changed")
      }),
      ("same user in another app is preserved", {
        let other = record("credential_other_app", key: otherKey, appId: "com.other.fixture")
        let store = try Store([record(), other], keys: [deletedKey, otherKey])
        _ = try store.erase()
        try expect(store.keys == [otherKey] && store.snapshot?.data == (try data([other])), "Other app data was erased")
      }),
      ("no target credential leaves original bytes untouched", {
        let store = try Store([record("credential_other", user: "user_other", key: otherKey)], keys: [otherKey])
        let before = store.snapshot
        try expect(try store.erase() == 0 && store.snapshot == before && store.replacements == 0, "Unrelated metadata was rewritten")
      }),
      ("last credential removes metadata and retry is idempotent", {
        let store = try Store([record()], keys: [deletedKey])
        try expect(try store.erase() == 1 && store.snapshot == nil && store.keys.isEmpty, "Last credential was retained")
        try expect(try store.erase() == 0, "Repeated cleanup did not settle")
      }),
      ("missing private key still permits metadata cleanup", {
        let store = try Store([record()])
        try expect(try store.erase() == 1 && store.snapshot == nil, "An interrupted key deletion could not resume")
      }),
      ("partial key failure retains ownership metadata for retry", {
        let store = try Store([record(), record("credential_second", key: secondKey)], keys: [deletedKey, secondKey])
        let before = store.snapshot
        store.failKey = secondKey
        try rejects(store)
        try expect(store.snapshot == before && store.replacements == 0 && store.keys == [secondKey], "Failure discarded recovery metadata")
        store.failKey = nil
        try expect(try store.erase() == 2 && store.snapshot == nil && store.keys.isEmpty, "Retry did not finish partial erasure")
      }),
      ("metadata write failure retains enough information to retry", {
        let store = try Store([record()], keys: [deletedKey])
        let before = store.snapshot
        store.failWrite = true
        try rejects(store)
        try expect(store.snapshot == before && store.keys.isEmpty, "Write failure lost the recoverable state")
        store.failWrite = false
        try expect(try store.erase() == 1 && store.snapshot == nil, "Failed metadata write could not resume")
      }),
      ("successful deletion status alone does not prove key absence", {
        let store = try Store([record()], keys: [deletedKey])
        store.keepKey = true
        try rejects(store)
        try expect(store.replacements == 0, "Metadata was erased while the key survived")
      }),
      ("changed ownership metadata is never overwritten", {
        let store = try Store([record()], keys: [deletedKey])
        let changed = try data([record(), record("credential_other", user: "user_other", key: otherKey)])
        store.afterRemove = { store.snapshot = ClerkBiometricSnapshot(reference: Data("fixture".utf8), data: changed) }
        try rejects(store)
        try expect(store.replacements == 0 && store.snapshot?.data == changed, "Concurrent metadata change was overwritten")
        store.afterRemove = nil
      }),
      ("ambiguous duplicate keys and credential identifiers are rejected before mutation", {
        let ambiguous = [
          [record(), record("credential_other", user: "user_other")],
          [record(), record(key: otherKey)]
        ]
        for records in ambiguous {
          let store = try Store(records, keys: [deletedKey, otherKey])
          try rejects(store)
          try expect(store.removed.isEmpty && store.replacements == 0, "Ambiguous ownership reached mutation")
        }
      }),
      ("unsupported or malformed records never reach mutation", {
        let replacements: [(String, Any)] = [("userId", ""), ("appIdentifier", NSNull()), ("localKeyId", "unscoped"),
          ("id", ""), ("policy", "future_policy"), ("createdAt", true), ("updatedAt", "yesterday"),
          ("identifierHint", 17), ("futureCredential", "unknown")]
        for (key, value) in replacements {
          var invalid = record(); invalid[key] = value
          let store = try Store([invalid], keys: [deletedKey])
          try rejects(store)
          try expect(store.removed.isEmpty && store.replacements == 0, "Unsupported schema reached mutation")
        }
      }),
      ("corrupt and oversized metadata are rejected", {
        for bytes in [Data("{broken".utf8), Data("{}".utf8), Data(repeating: 32, count: 1024 * 1024 + 1)] {
          let store = try Store(nil)
          store.snapshot = ClerkBiometricSnapshot(reference: Data("fixture".utf8), data: bytes)
          try rejects(store)
          try expect(store.removed.isEmpty, "Corrupt metadata reached mutation")
        }
      }),
      ("invalid account is rejected even when storage is empty", {
        let store = try Store(nil)
        var rejected = false
        do { _ = try ClerkBiometricCleanup.erase(accountId: "", appIdentifier: app, storage: store) }
        catch { rejected = true }
        try expect(rejected, "Invalid account was treated as cleaned")
      })
    ]
    for (name, test) in tests { try test(); print("PASS: \(name)") }
    print("Passed \(tests.count) native Clerk biometric cleanup checks")
  }
}
