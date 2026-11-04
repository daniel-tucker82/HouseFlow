package com.cyntch.clerkstate

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ClerkBiometricRecordsTest {
  private fun record(id: String, user: String = "user_deleted", app: String = "com.cyntch.app") = JSONObject()
    .put("id", id).put("local_key_id", "tdlk_$id").put("user_id", user).put("app_identifier", app)
    .put("policy", "biometry_current_set").put("created_at", 123L).put("updated_at", 456L)
  private fun inspect(vararg records: JSONObject) = ClerkBiometricRecords.targetKeys(
    JSONObject().put("version", 2).put("credentials", JSONArray(records)).toString(), "user_deleted", "com.cyntch.app")

  @Test fun keysAreScopedToBothAccountAndApplication() {
    assertEquals(setOf("tdlk_a", "tdlk_b"), inspect(record("a"), record("b"), record("c", "user_other"), record("d", app = "another.app")))
    assertEquals(emptySet<String>(), inspect(record("other", "user_other")))
    assertEquals(emptySet<String>(), inspect())
    assertEquals(emptySet<String>(), ClerkBiometricRecords.targetKeys(null, "user_deleted", "com.cyntch.app"))
  }

  @Test fun malformedOrUnknownDocumentsAreNotEmptyStores() {
    for (json in listOf("", "null", "[]", "{}", "{\"version\":3,\"credentials\":[]}",
      "{\"version\":\"2\",\"credentials\":[]}", "{\"version\":2,\"credentials\":null}",
      "{\"version\":2,\"credentials\":[null]}", "{\"version\":2,\"credentials\":[{}]}")) {
      assertThrows(Exception::class.java) { ClerkBiometricRecords.targetKeys(json, "user_deleted", "com.cyntch.app") }
    }
  }

  @Test fun anUndecodableRecordCannotHideItsKeyOrCauseAnotherRecordToBeLost() {
    val changes: List<(JSONObject) -> Unit> = listOf(
      { it.remove("local_key_id") }, { it.put("user_id", JSONObject.NULL) }, { it.put("policy", "unknown") },
      { it.put("created_at", "123") }, { it.put("updated_at", 1.5) }, { it.put("identifier_hint_sha256", false) }
    )
    for (change in changes) {
      val invalid = record("broken", "user_other").also(change)
      assertThrows(Exception::class.java) { inspect(record("target"), invalid) }
    }
  }

  @Test fun sharedRecordIdsOrPrivateKeysCannotEraseAnotherAccountsCredential() {
    assertThrows(Exception::class.java) { inspect(record("duplicate"), record("duplicate", "user_other")) }
    assertThrows(Exception::class.java) { inspect(record("target"), record("other", "user_other").put("local_key_id", "tdlk_target")) }
  }

  @Test fun pendingCleanupMustBeAnArrayOfAccountIds() {
    for (pending in listOf(JSONObject.NULL, "user_deleted", JSONArray().put(5))) {
      val json = JSONObject().put("version", 2).put("credentials", JSONArray()).put("pending_cleanup_user_ids", pending).toString()
      assertThrows(Exception::class.java) { ClerkBiometricRecords.targetKeys(json, "user_deleted", "com.cyntch.app") }
    }
  }
}
