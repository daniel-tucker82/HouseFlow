import Foundation
import Security

// Runs on the isolated Mac CI runner. Every item is newly created under a
// random fixture service/tag and removed afterward. Software keys verify the
// Security query path; they do not stand in for Face ID/Secure Enclave testing.
@main
struct ClerkKeychainTests {
  enum Failure: Error { case assertion(String), security(String, OSStatus) }
  static func expect(_ value: Bool, _ message: String) throws {
    if !value { throw Failure.assertion(message) }
  }
  static func success(_ status: OSStatus, _ action: String) throws {
    if status != errSecSuccess { throw Failure.security(action, status) }
  }
  static func bytes(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }

  @MainActor
  final class Fixture {
    let service = "com.cyntch.keychain-tests." + UUID().uuidString.lowercased()
    var ownedQueries: [[String: Any]] = []
    func password(_ account: String, _ data: Data) throws {
      let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: account]
      var addition = query; addition[kSecValueData as String] = data
      try ClerkKeychainTests.success(SecItemAdd(addition as CFDictionary, nil), "add fixture metadata")
      ownedQueries.append(query)
    }
    func key() throws -> String {
      let id = "tdlk_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
      let tag = Data("dev.clerk.trusted_device.\(id)".utf8)
      let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag]]
      var error: Unmanaged<CFError>?
      guard SecKeyCreateRandomKey(attributes as CFDictionary, &error) != nil else {
        if let error { _ = error.takeRetainedValue() }
        throw Failure.assertion("Unable to create the isolated software key fixture")
      }
      ownedQueries.append([kSecClass as String: kSecClassKey, kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrApplicationTag as String: tag])
      return id
    }
    func clear() throws {
      for query in ownedQueries {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.security("remove fixture", status) }
      }
      ownedQueries = []
    }
  }

  static func record(_ key: String, user: String) -> [String: Any] {
    ["id": "credential_" + key, "localKeyId": key, "userId": user, "appIdentifier": "com.cyntch.fixture",
      "policy": "biometry_current_set", "createdAt": 1_793_779_200_000, "updatedAt": 1_793_779_200_000]
  }

  @MainActor
  static func main() throws {
    let fixture = Fixture()
    do {
      let firstKey = try fixture.key(), secondKey = try fixture.key()
      let other = record(secondKey, user: "user_other")
      try fixture.password("trustedDeviceCredentials", bytes([record(firstKey, user: "user_deleted"), other]))
      let store = ClerkBiometricKeychain(service: fixture.service)
      try expect(try store.hasKey(firstKey) && store.hasKey(secondKey), "Fixture keys were not readable")
      try expect(try ClerkBiometricCleanup.erase(accountId: "user_deleted", appIdentifier: "com.cyntch.fixture", storage: store) == 1,
        "Account-scoped Keychain cleanup did not remove exactly one record")
      try expect(try !store.hasKey(firstKey) && store.hasKey(secondKey), "Wrong software key survived cleanup")
      try expect(try store.read()?.data == bytes([other]), "Other member's metadata did not survive the persistent-reference update")
      print("PASS: native Keychain read/update removes one account and preserves another")

      try expect(try ClerkBiometricCleanup.erase(accountId: "user_other", appIdentifier: "com.cyntch.fixture", storage: store) == 1,
        "Last credential cleanup failed")
      try expect(try store.read() == nil && !store.hasKey(secondKey), "Last private key or metadata remained")
      try expect(try ClerkBiometricCleanup.erase(accountId: "user_other", appIdentifier: "com.cyntch.fixture", storage: store) == 0,
        "Repeated Keychain cleanup was not idempotent")
      print("PASS: native Keychain removal deletes the last credential and permits retry")

      try fixture.password("cachedClient", bytes(["id": "client_fixture", "sessions": [["id": "session_fixture", "user": ["id": "user_deleted"]]]]))
      let present = ClerkPersistenceInspection.inspect(services: [fixture.service], accountId: "user_deleted")
      try expect(present.ready && present.hasAccount && !present.hasUnidentifiedSession, "Reference-based cache read missed the target account")
      let absent = ClerkPersistenceInspection.inspect(services: [fixture.service], accountId: "user_other")
      try expect(absent.ready && !absent.hasAccount, "Cache read incorrectly found another account")
      print("PASS: native Keychain cache inspection follows enumerated references")

      try fixture.clear()
      try expect(ClerkPersistenceInspection.inspect(services: [fixture.service], accountId: "user_deleted").ready,
        "Empty fixture store could not be inspected")
      print("Passed 3 native Security API checks; all owned fixtures removed")
    } catch {
      try fixture.clear()
      throw error
    }
  }
}
