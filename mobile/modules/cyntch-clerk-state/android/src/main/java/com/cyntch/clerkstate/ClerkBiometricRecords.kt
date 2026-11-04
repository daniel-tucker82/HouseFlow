package com.cyntch.clerkstate

import org.json.JSONObject

/** Validate before asking Clerk 1.3.0 to erase anything: its metadata reader can
 * treat corrupt/unknown documents or records as empty. That is not proof that
 * their keys have been removed. No provider data leaves this native boundary. */
internal object ClerkBiometricRecords {
  fun targetKeys(json: String?, accountId: String, appIdentifier: String): Set<String> {
    if (json == null) return emptySet()
    val root = JSONObject(json)
    require(root.get("version") == 2)
    val records = root.getJSONArray("credentials")
    val ids = mutableSetOf<String>()
    val keys = mutableSetOf<String>()
    val target = mutableSetOf<String>()
    for (index in 0 until records.length()) {
      val record = records.getJSONObject(index)
      fun field(name: String): String {
        val value = record.get(name)
        require(value is String && value.isNotBlank())
        return value
      }
      val id = field("id")
      val key = field("local_key_id")
      val owner = field("user_id")
      val app = field("app_identifier")
      require(owner.matches(Regex("^user_[A-Za-z0-9_-]{1,200}$")))
      require(ids.add(id) && keys.add(key))
      require(field("policy") in setOf("biometry_current_set", "biometry_any", "biometry_or_device_passcode"))
      for (name in listOf("created_at", "updated_at")) {
        val value = record.get(name)
        require(value is Number && value.toString().toLongOrNull() != null)
      }
      if (!record.isNull("identifier_hint_sha256")) require(record.get("identifier_hint_sha256") is String)
      if (owner == accountId && app == appIdentifier) target.add(key)
    }
    if (root.has("pending_cleanup_user_ids")) {
      val pending = root.getJSONArray("pending_cleanup_user_ids")
      for (index in 0 until pending.length()) require(pending.get(index) is String)
    }
    return target
  }
}
