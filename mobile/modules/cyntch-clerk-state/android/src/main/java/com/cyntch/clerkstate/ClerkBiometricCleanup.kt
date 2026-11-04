package com.cyntch.clerkstate

import android.content.Context
import com.clerk.api.Clerk
import java.io.File
import java.nio.ByteBuffer
import java.security.KeyStore

/** Called off the UI thread, only after the JS coordinator checks its durable
 * accepted-deletion fence. Uses Clerk's public account-scoped erasure method;
 * never resets the client or touches the shared device authentication token. */
internal object ClerkBiometricCleanup {
  fun forget(context: Context, accountId: String): Map<String, Any> {
    var stage = "readiness"
    try {
      require(accountId.matches(Regex("^user_[A-Za-z0-9_-]{1,200}$")))
      // An initialized signed-out SDK need not have a client profile. Local
      // private-key cleanup depends on configured storage, not that profile.
      require(Clerk.isInitialized.value)
      val configuration = Clerk.publishableKey
      require(!configuration.isNullOrBlank())
      stage = "metadata"
      val keys = targetKeys(context, accountId)
      stage = "sdk"
      val removed = Clerk.biometricCredentials.forgetLocalCredentials(accountId)
      require(Clerk.isInitialized.value && Clerk.publishableKey == configuration)
      stage = "remaining-records"
      require(targetKeys(context, accountId).isEmpty())
      stage = "remaining-keys"
      val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      require(keys.none { keyStore.containsAlias("com.clerk.trusted_device.$it") })
      return mapOf("format" to 1, "removedCount" to removed)
    } catch (failure: Exception) {
      // Source location and exception type aid native diagnostics without
      // returning the original message, cause, credentials or key metadata.
      val location = failure.stackTrace.firstOrNull { it.className.startsWith("com.cyntch.clerkstate.") }
      throw IllegalStateException("Biometric sign-in cleanup could not be verified ($stage/${failure.javaClass.simpleName}/${location?.fileName}:${location?.lineNumber}).")
    }
  }

  private fun targetKeys(context: Context, accountId: String): Set<String> {
    val directory = File(context.applicationInfo.dataDir, "shared_prefs")
    val preferences = listOf(File(directory, "clerk_preferences.xml"), File(directory, "clerk_preferences.xml.bak"))
    // Let SDK initialization perform its normal legacy migration. An unretired
    // legacy record or backup is not safe to treat as an empty credential store.
    for (file in preferences) {
      val xml = ClerkPersistenceReader.read(file) ?: continue
      for (key in listOf("TRUSTED_DEVICE_CREDENTIALS", "PENDING_TRUSTED_DEVICE_CREDENTIAL_CLEANUP")) {
        require(ClerkPersistenceInspection.cacheValue(xml, key) == null)
      }
    }
    val file = File(context.noBackupFilesDir, "clerk/biometric_credentials.v2.json")
    val before = ClerkPersistenceReader.read(file)
    val json = before?.let { Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(it)).toString() }
    val keys = ClerkBiometricRecords.targetKeys(json, accountId, context.packageName)
    require(before.contentEquals(ClerkPersistenceReader.read(file)))
    return keys
  }
}
