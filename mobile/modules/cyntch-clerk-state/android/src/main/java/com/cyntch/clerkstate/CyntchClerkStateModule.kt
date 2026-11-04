package com.cyntch.clerkstate

import com.clerk.api.Clerk
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** No tokens, names, email addresses or other accounts' identifiers cross this
 * boundary. This module does not configure, clear or mutate Clerk state. */
class CyntchClerkStateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CyntchClerkState")

    AsyncFunction("inspectAccount") { accountId: String ->
      require(accountId.matches(Regex("^user_[A-Za-z0-9_-]{1,200}$")))
      val client = Clerk.clientFlow.value
      val ready = Clerk.isInitialized.value && client != null
      val sessions = client?.sessions.orEmpty()
      mapOf(
        "format" to 1,
        "ready" to ready,
        "hasAccount" to sessions.any { it.user?.id == accountId },
        "hasUnidentifiedSession" to sessions.any { it.user?.id == null },
        "hasAuthenticationSnapshot" to (client?.signIn != null || client?.signUp != null)
      )
    }
  }
}
