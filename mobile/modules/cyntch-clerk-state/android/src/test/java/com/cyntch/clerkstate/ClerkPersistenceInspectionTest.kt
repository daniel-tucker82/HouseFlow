package com.cyntch.clerkstate

import org.junit.Assert.*
import org.junit.Test

class ClerkPersistenceInspectionTest {
  private fun inspect(client: String) = ClerkPersistenceInspection.inspect("{\"client\":$client}", "user_deleted")
  private fun xml(value: String) = ClerkPersistenceInspection.cacheValue(value.toByteArray())

  @Test fun retainedProfilesAndOtherAccountsAreDistinguished() {
    assertEquals(true, inspect("""{"sessions":[{"user":{"id":"user_deleted"}}]}""")["hasAccount"])
    val other = inspect("""{"sessions":[{"user":{"id":"user_other"}}]}""")
    assertEquals(true, other["ready"])
    assertEquals(false, other["hasAccount"])
    assertEquals(false, other["hasUnidentifiedSession"])
    assertEquals(setOf("format", "ready", "hasAccount", "hasUnidentifiedSession", "hasAuthenticationSnapshot"), other.keys)
  }

  @Test fun omittedEmptyDefaultsAndMissingCacheAreRecognized() {
    assertEquals(true, inspect("{}")["ready"])
    assertEquals(false, inspect("{}")["hasAccount"])
    assertEquals(ClerkPersistenceInspection.verdict(true), ClerkPersistenceInspection.inspect(null, "user_deleted"))
  }

  @Test fun invalidOrFutureCacheShapesAreNotProofOfErasure() {
    for (value in listOf("", "null", "[]", "{}", "{\"client\":null}", "{\"client\":{\"sessions\":null}}",
      "{\"client\":{\"sessions\":[null]}}", "{\"client\":{\"future_profile\":{}}}")) {
      assertEquals(value, false, ClerkPersistenceInspection.inspect(value, "user_deleted")["ready"])
    }
  }

  @Test fun unidentifiedAndAuthenticationSnapshotsRemainVisible() {
    for (session in listOf("{}", "{\"user\":null}", "{\"user\":{\"id\":2}}", "{\"user\":{\"id\":\"\"}}")) {
      assertEquals(true, inspect("{\"sessions\":[$session]}")["hasUnidentifiedSession"])
    }
    assertEquals(true, inspect("""{"sign_in":{"id":"sia_pending"}}""")["hasAuthenticationSnapshot"])
    assertEquals(true, inspect("""{"sign_up":{"id":"sua_pending"}}""")["hasAuthenticationSnapshot"])
    assertEquals(false, inspect("""{"sign_in":null,"sign_up":null}""")["hasAuthenticationSnapshot"])
  }

  @Test fun readsOnlyTheCacheEntryWithoutExposingOtherPreferences() {
    assertEquals("{\"client\":{}}", xml("""<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name="DEVICE_TOKEN">private</string><string name="CACHED_CLERK_STATE">{&quot;client&quot;:{}}</string></map>"""))
    assertNull(xml("<map><string name='DEVICE_TOKEN'>private</string></map>"))
    assertNull(xml("<map />"))
  }

  @Test fun malformedXmlAndExternalEntitiesCannotBeMistakenForAnEmptyCache() {
    for (value in listOf("", "<map>", "<wrong />", "<map><int name='CACHED_CLERK_STATE' value='1'/></map>",
      "<map><string name='CACHED_CLERK_STATE'>a</string><string name='CACHED_CLERK_STATE'>b</string></map>",
      "<map><string name='CACHED_CLERK_STATE'><nested /></string></map>",
      "<!DOCTYPE map [<!ENTITY secret SYSTEM 'file:///never-read'>]><map>&secret;</map>")) {
      assertThrows(Exception::class.java) { xml(value) }
    }
    assertThrows(Exception::class.java) { ClerkPersistenceInspection.cacheValue("<!DOCTYPE map><map />".toByteArray(Charsets.UTF_16)) }
  }

  @Test fun anInterruptedWriteBackupCannotHideBehindAClearedPrimary() {
    val clear = "<map><string name='CACHED_CLERK_STATE'>{\"client\":{}}</string></map>".toByteArray()
    val old = "<map><string name='CACHED_CLERK_STATE'>{\"client\":{\"sessions\":[{\"user\":{\"id\":\"user_deleted\"}}]}}</string></map>".toByteArray()
    assertEquals(true, ClerkPersistenceInspection.inspectSnapshots("user_deleted", { listOf(clear, old) }, { it })["hasAccount"])
    assertEquals(true, ClerkPersistenceInspection.inspectSnapshots("user_deleted", { listOf(null, old) }, { it })["hasAccount"])
    assertEquals(false, ClerkPersistenceInspection.inspectSnapshots("user_deleted", { listOf(clear, null) }, { it })["hasAccount"])
    assertEquals(true, ClerkPersistenceInspection.inspectSnapshots("user_deleted", { listOf(null, null) }, { it })["ready"])
  }

  @Test fun storageChangesReadFailuresAndMissingKeysKeepVerificationIncomplete() {
    val first = "<map/>".toByteArray()
    val second = "<map><string name='DEVICE_TOKEN'>rotated</string></map>".toByteArray()
    var reads = 0
    assertEquals(false, ClerkPersistenceInspection.inspectSnapshots("user_deleted", {
      reads += 1; listOf(if (reads == 1) first else second, null)
    }, { it })["ready"])
    assertEquals(false, ClerkPersistenceInspection.inspectSnapshots("user_deleted", { throw java.io.IOException() }, { it })["ready"])
    val encrypted = "<map><string name='CACHED_CLERK_STATE'>clerk:v1:encrypted</string></map>".toByteArray()
    assertEquals(false, ClerkPersistenceInspection.inspectSnapshots("user_deleted", { listOf(encrypted, null) }, { throw java.security.UnrecoverableKeyException() })["ready"])
    assertEquals(false, ClerkPersistenceInspection.inspectSnapshots("user_deleted", { listOf(first) }, { it })["ready"])
  }
}
