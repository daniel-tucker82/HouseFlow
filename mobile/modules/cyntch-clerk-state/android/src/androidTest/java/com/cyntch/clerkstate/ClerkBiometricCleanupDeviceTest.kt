package com.cyntch.clerkstate

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.platform.app.InstrumentationRegistry
import com.clerk.api.Clerk
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Runs in this library's isolated test APK, never the Cyntch app sandbox.
 * Generates local fixture keys only; no Clerk user or biometric enrollment is
 * created/deleted. Tests the real pinned SDK's disk/Keystore cleanup path. */
class ClerkBiometricCleanupDeviceTest {
  @Test(timeout = 60_000) fun erasesOnlyTheAcceptedAccountsKeysAndSurvivesRetry() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    assertEquals("com.cyntch.clerkstate.test", context.packageName)
    val publishableKey = InstrumentationRegistry.getArguments().getString("cyntchClerkPublishableKey")
    require(publishableKey != null && publishableKey.startsWith("pk_test_"))
    instrumentation.runOnMainSync { Clerk.initialize(context, publishableKey) }
    val deadline = System.currentTimeMillis() + 30_000
    while (!Clerk.isInitialized.value && System.currentTimeMillis() < deadline) Thread.sleep(100)
    assertTrue("The isolated development SDK did not initialize", Clerk.isInitialized.value)

    val file = File(context.noBackupFilesDir, "clerk/biometric_credentials.v2.json")
    if (file.exists()) assertEquals("Test sandbox contains credentials", 0, JSONObject(file.readText()).getJSONArray("credentials").length())
    val marker = UUID.randomUUID().toString().replace("-", "")
    val keyIds = (0..3).map { "tdlk_cyntch_test_${marker}_$it" }
    val aliases = keyIds.map { "com.clerk.trusted_device.$it" }
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    try {
      for (alias in aliases) {
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
          initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).build())
        }.generateKeyPair()
      }
      val records = JSONArray()
      for (index in keyIds.indices) records.put(JSONObject()
        .put("id", "tdc_cyntch_test_${marker}_$index").put("local_key_id", keyIds[index])
        .put("user_id", if (index == 2) "user_cyntch_other" else "user_cyntch_deleted")
        .put("app_identifier", if (index == 3) "com.cyntch.another.test" else context.packageName)
        .put("policy", "biometry_current_set").put("created_at", 1L).put("updated_at", 1L)
        .put("retained_fixture_field", "fixture-$index"))
      val store = JSONObject().put("version", 2).put("credentials", records).put("pending_cleanup_user_ids", JSONArray())
      assertTrue(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs())
      file.writeText(store.toString())

      val result = ClerkBiometricCleanup.forget(context, "user_cyntch_deleted")
      assertEquals(2, result["removedCount"])
      assertFalse(keyStore.containsAlias(aliases[0])); assertFalse(keyStore.containsAlias(aliases[1]))
      assertTrue(keyStore.containsAlias(aliases[2])); assertTrue(keyStore.containsAlias(aliases[3]))
      val retained = JSONObject(file.readText()).getJSONArray("credentials")
      assertEquals(2, retained.length())
      assertEquals("user_cyntch_other", retained.getJSONObject(0).getString("user_id"))
      assertEquals("fixture-2", retained.getJSONObject(0).getString("retained_fixture_field"))
      assertEquals("com.cyntch.another.test", retained.getJSONObject(1).getString("app_identifier"))
      assertEquals(0, ClerkBiometricCleanup.forget(context, "user_cyntch_deleted")["removedCount"])

      // A future/corrupt store must fail before the SDK can treat it as empty.
      val unsupported = JSONObject(file.readText()).put("version", 99).toString()
      file.writeText(unsupported)
      assertThrows(IllegalStateException::class.java) { ClerkBiometricCleanup.forget(context, "user_cyntch_other") }
      assertEquals(unsupported, file.readText())
      assertTrue(keyStore.containsAlias(aliases[2])); assertTrue(keyStore.containsAlias(aliases[3]))
    } finally {
      // Only this test's exact aliases and the isolated fixture file are removed.
      aliases.forEach { if (keyStore.containsAlias(it)) keyStore.deleteEntry(it) }
      file.delete()
      instrumentation.runOnMainSync { Clerk.reset() }
    }
  }
}
