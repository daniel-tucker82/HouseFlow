import Foundation
import Security

// Pinned to ClerkKit 1.6.2. Its account-scoped forgetLocalCredentials API is
// package-only on iOS. Keep ownership metadata until every associated private
// key is gone, so an interrupted attempt can safely resume.
enum ClerkBiometricCleanupError: Error { case unavailable }

struct ClerkBiometricSnapshot: Equatable {
  let reference: Data
  let data: Data
}

@MainActor
protocol ClerkBiometricStorage {
  func read() throws -> ClerkBiometricSnapshot?
  func removeKey(_ localKeyId: String) throws
  func hasKey(_ localKeyId: String) throws -> Bool
  func replace(_ snapshot: ClerkBiometricSnapshot, with data: Data?) throws
}

enum ClerkBiometricCleanup {
  struct Plan {
    let keys: [String]
    let remaining: Data?
  }

  static func plan(data: Data, accountId: String, appIdentifier: String) throws -> Plan {
    guard accountId.range(of: "^user_[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
          !appIdentifier.isEmpty, data.count <= 1024 * 1024,
          let records = try JSONSerialization.jsonObject(with: data) as? [[String: Any]],
          records.count <= 1024 else { throw ClerkBiometricCleanupError.unavailable }
    let allowed: Set<String> = ["id", "localKeyId", "userId", "appIdentifier", "identifierHint", "policy", "createdAt", "updatedAt"]
    let policies = ["biometry_current_set", "biometry_any", "biometry_or_device_passcode"]
    var ids = Set<String>(), keyIds = Set<String>(), keys: [String] = [], remaining: [[String: Any]] = []
    for record in records {
      guard Set(record.keys).isSubset(of: allowed),
            let id = record["id"] as? String, !id.isEmpty, id.count <= 256,
            let keyId = record["localKeyId"] as? String,
            keyId.range(of: "^tdlk_[a-f0-9]{32}$", options: .regularExpression) != nil,
            let user = record["userId"] as? String,
            user.range(of: "^user_[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
            let app = record["appIdentifier"] as? String, !app.isEmpty, app.count <= 256,
            let policy = record["policy"] as? String, policies.contains(policy),
            validDate(record["createdAt"]), validDate(record["updatedAt"]),
            ids.insert(id).inserted, keyIds.insert(keyId).inserted else { throw ClerkBiometricCleanupError.unavailable }
      if let hint = record["identifierHint"], !(hint is NSNull), !(hint is String) {
        throw ClerkBiometricCleanupError.unavailable
      }
      if user == accountId && app == appIdentifier { keys.append(keyId) }
      else { remaining.append(record) }
    }
    return Plan(keys: keys, remaining: remaining.isEmpty ? nil : try JSONSerialization.data(withJSONObject: remaining, options: [.sortedKeys]))
  }

  private static func validDate(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
    return number.doubleValue.isFinite && number.doubleValue >= 0
  }

  // Clerk's credential-store mutations also run synchronously on MainActor.
  // No suspension occurs between reading ownership and verifying the write.
  // This does NOT fence a still-running SDK enrollment that finishes later.
  @MainActor
  static func erase(accountId: String, appIdentifier: String, storage: any ClerkBiometricStorage) throws -> Int {
    guard accountId.range(of: "^user_[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
          !appIdentifier.isEmpty else { throw ClerkBiometricCleanupError.unavailable }
    guard let before = try storage.read() else { return 0 }
    let change = try plan(data: before.data, accountId: accountId, appIdentifier: appIdentifier)
    guard !change.keys.isEmpty else { return 0 }
    for key in change.keys { try storage.removeKey(key) }
    for key in change.keys {
      guard try !storage.hasKey(key) else { throw ClerkBiometricCleanupError.unavailable }
    }
    guard try storage.read() == before else { throw ClerkBiometricCleanupError.unavailable }
    try storage.replace(before, with: change.remaining)
    let after = try storage.read()
    guard after?.data == change.remaining else { throw ClerkBiometricCleanupError.unavailable }
    for key in change.keys {
      guard try !storage.hasKey(key) else { throw ClerkBiometricCleanupError.unavailable }
    }
    return change.keys.count
  }
}

@MainActor
struct ClerkBiometricKeychain: ClerkBiometricStorage {
  let service: String

  func read() throws -> ClerkBiometricSnapshot? {
    guard !service.isEmpty else { throw ClerkBiometricCleanupError.unavailable }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "trustedDeviceCredentials",
      kSecReturnPersistentRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    // A query without an access group can match more than one item. Never
    // arbitrarily choose one or overwrite several unrelated stores.
    guard status == errSecSuccess, let references = result as? [Data], references.count == 1,
          let reference = references.first, !reference.isEmpty else { throw ClerkBiometricCleanupError.unavailable }
    // Password data cannot be requested with kSecMatchLimitAll. Enumerate
    // references first, then read exactly the identified metadata item.
    let readQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecMatchItemList as String: [reference],
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var value: CFTypeRef?
    guard SecItemCopyMatching(readQuery as CFDictionary, &value) == errSecSuccess,
          let data = value as? Data, !data.isEmpty else { throw ClerkBiometricCleanupError.unavailable }
    return ClerkBiometricSnapshot(reference: reference, data: data)
  }

  private func keyQuery(_ localKeyId: String) throws -> [String: Any] {
    guard localKeyId.range(of: "^tdlk_[a-f0-9]{32}$", options: .regularExpression) != nil else {
      throw ClerkBiometricCleanupError.unavailable
    }
    return [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag as String: Data("dev.clerk.trusted_device.\(localKeyId)".utf8)
    ]
  }

  func removeKey(_ localKeyId: String) throws {
    let status = SecItemDelete(try keyQuery(localKeyId) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw ClerkBiometricCleanupError.unavailable }
  }

  func hasKey(_ localKeyId: String) throws -> Bool {
    var query = try keyQuery(localKeyId)
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    let status = SecItemCopyMatching(query as CFDictionary, nil)
    if status == errSecItemNotFound { return false }
    guard status == errSecSuccess else { throw ClerkBiometricCleanupError.unavailable }
    return true
  }

  func replace(_ snapshot: ClerkBiometricSnapshot, with data: Data?) throws {
    guard try read() == snapshot else { throw ClerkBiometricCleanupError.unavailable }
    let query = [kSecClass as String: kSecClassGenericPassword,
                 kSecMatchItemList as String: [snapshot.reference]] as CFDictionary
    let status: OSStatus
    if let data { status = SecItemUpdate(query, [kSecValueData as String: data] as CFDictionary) }
    else { status = SecItemDelete(query) }
    guard status == errSecSuccess else { throw ClerkBiometricCleanupError.unavailable }
  }
}
