import Foundation
import Security

/** ClerkKit 1.6.2 profile cache only. This does not delete credentials, change
 * SDK state or establish that a later response cannot write another snapshot. */
struct ClerkPersistenceVerdict: Sendable {
  var ready = true
  var hasAccount = false
  var hasUnidentifiedSession = false
  var hasAuthenticationSnapshot = false

  var payload: [String: Any] {
    ["format": 1, "ready": ready, "hasAccount": hasAccount,
     "hasUnidentifiedSession": hasUnidentifiedSession,
     "hasAuthenticationSnapshot": hasAuthenticationSnapshot]
  }
}

enum ClerkPersistenceInspection {
  static func inspect(services: [String], accountId: String) -> ClerkPersistenceVerdict {
    do {
      let before = try services.flatMap(read)
      var result = ClerkPersistenceVerdict()
      for data in before {
        let verdict = try inspect(data: data, accountId: accountId)
        result.hasAccount = result.hasAccount || verdict.hasAccount
        result.hasUnidentifiedSession = result.hasUnidentifiedSession || verdict.hasUnidentifiedSession
        result.hasAuthenticationSnapshot = result.hasAuthenticationSnapshot || verdict.hasAuthenticationSnapshot
      }
      guard before == (try services.flatMap(read)) else { return ClerkPersistenceVerdict(ready: false) }
      return result
    } catch { return ClerkPersistenceVerdict(ready: false) }
  }

  private static func read(service: String) throws -> [Data] {
    // Match all accessible access groups. With shared identity, Clerk migrates
    // app-local caches to a separate service; inspect both services, including
    // any legacy copy, without triggering migration or touching the token.
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "cachedClient",
      kSecReturnPersistentRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let references = result as? [Data],
          !references.isEmpty, references.count <= 64 else {
      throw InspectionError.unavailable
    }
    // Apple disallows returning all password data in one query. Read each
    // enumerated reference separately, and fail if an item disappears midway.
    let values: [Data] = try references.map { reference in
      let readQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecMatchItemList as String: [reference],
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
      ]
      var value: CFTypeRef?
      guard !reference.isEmpty, SecItemCopyMatching(readQuery as CFDictionary, &value) == errSecSuccess,
            let data = value as? Data, !data.isEmpty, data.count <= 8 * 1024 * 1024 else {
        throw InspectionError.unavailable
      }
      return data
    }
    return values.sorted { $0.lexicographicallyPrecedes($1) }
  }

  static func inspect(data: Data, accountId: String) throws -> ClerkPersistenceVerdict {
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw InspectionError.unavailable
    }
    // Current snapshots wrap a client; older ClerkKit cached the client alone.
    let client: [String: Any]
    if root.keys.contains("client") {
      guard let value = root["client"] as? [String: Any] else { throw InspectionError.unavailable }
      client = value
    } else { client = root }
    let allowed: Set<String> = ["id", "sign_in", "sign_up", "sessions", "last_active_session_id", "last_authentication_strategy", "updated_at"]
    guard Set(client.keys).isSubset(of: allowed), client["id"] is String,
          let sessions = client["sessions"] as? [[String: Any]] else { throw InspectionError.unavailable }
    var verdict = ClerkPersistenceVerdict()
    for session in sessions {
      let id = (session["user"] as? [String: Any])?["id"] as? String
      if id == nil || id?.range(of: "^user_[A-Za-z0-9_-]{1,200}$", options: .regularExpression) == nil {
        verdict.hasUnidentifiedSession = true
      }
      if id == accountId { verdict.hasAccount = true }
    }
    verdict.hasAuthenticationSnapshot = ["sign_in", "sign_up"].contains { key in
      client[key] != nil && !(client[key] is NSNull)
    }
    return verdict
  }

  private enum InspectionError: Error { case unavailable }
}
