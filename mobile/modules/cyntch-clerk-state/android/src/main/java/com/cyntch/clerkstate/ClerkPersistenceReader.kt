package com.cyntch.clerkstate

import android.content.Context
import android.util.Base64
import java.io.File
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Read-only adapter pinned to Clerk Android 1.3.0's storage format. Inspect the
 * recovery backup as well: Android can restore it after an interrupted write.
 * This is a point-in-time profile-cache check, not a fence against future writes. */
internal object ClerkPersistenceReader {
  private const val maxBytes = 8 * 1024 * 1024

  fun inspect(context: Context, accountId: String): Map<String, Any> = try {
    val directory = File(context.applicationInfo.dataDir, "shared_prefs")
    val files = listOf(File(directory, "clerk_preferences.xml"), File(directory, "clerk_preferences.xml.bak"))
    ClerkPersistenceInspection.inspectSnapshots(accountId, { files.map(::read) }, ::decrypt)
  } catch (_: Exception) { ClerkPersistenceInspection.verdict(false) }

  private fun read(file: File): ByteArray? {
    if (!file.exists()) return null
    require(file.isFile && file.length() in 1..maxBytes.toLong())
    return file.inputStream().use { stream ->
      // Bound the read even if a concurrent writer grows the file.
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(8192)
      while (true) {
        val count = stream.read(buffer)
        if (count < 0) break
        require(output.size() + count <= maxBytes)
        output.write(buffer, 0, count)
      }
      require(output.size() > 0)
      output.toByteArray()
    }
  }

  private fun decrypt(value: String): String {
    // Older SDK versions stored plaintext; inspect it without migrating it.
    if (!value.startsWith("clerk:v1:")) return value
    val parts = value.removePrefix("clerk:v1:").split(':')
    require(parts.size == 2)
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val key = keyStore.getKey("clerk_preferences.master_key", null) as? SecretKey
      ?: throw IllegalStateException("Storage key unavailable")
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
    return cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)).toString(Charsets.UTF_8)
  }
}
