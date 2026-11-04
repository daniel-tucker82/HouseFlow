import ClerkKit
import ExpoModulesCore

/** The JS adapter first checks ClerkExpo.getAuthFlowState().isLoaded. This is
 * required: Clerk.shared asserts if its existing Expo bridge has not configured
 * it. Inspect only; never configure another instance or reset a shared token. */
public class CyntchClerkStateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CyntchClerkState")

    AsyncFunction("inspectPersistence") { (accountId: String, promise: Promise) in
      Task { @MainActor in
        guard accountId.range(of: "^user_[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
              Clerk.shared.isLoaded else {
          promise.resolve(ClerkPersistenceVerdict(ready: false).payload)
          return
        }
        let config = Clerk.shared.options.keychainConfig
        var services = [config.service]
        if let group = config.accessGroup, !group.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          services.append("\(Bundle.main.bundleIdentifier ?? config.service).clerk.app")
        }
        guard services.allSatisfy({ !$0.isEmpty }) else {
          promise.resolve(ClerkPersistenceVerdict(ready: false).payload)
          return
        }
        let storageServices = services
        let verdict = await Task.detached(priority: .utility) {
          ClerkPersistenceInspection.inspect(services: storageServices, accountId: accountId)
        }.value
        promise.resolve(verdict.payload)
      }
    }

    AsyncFunction("inspectAccount") { (accountId: String, promise: Promise) in
      Task { @MainActor in
        guard accountId.range(of: "^user_[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil else {
          promise.reject("E_ACCOUNT", "Account inspection is unavailable.")
          return
        }
        let clerk = Clerk.shared
        let client = clerk.client
        let sessions = client?.sessions ?? []
        promise.resolve([
          "format": 1,
          "ready": clerk.isLoaded && client != nil,
          "hasAccount": sessions.contains { $0.user?.id == accountId },
          "hasUnidentifiedSession": sessions.contains { $0.user?.id == nil },
          "hasAuthenticationSnapshot": client?.signIn != nil || client?.signUp != nil
        ] as [String: Any])
      }
    }
  }
}
