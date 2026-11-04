package com.cyntch.clerkstate

import org.json.JSONObject
import org.xml.sax.ErrorHandler
import org.xml.sax.SAXParseException
import java.io.StringReader
import java.nio.ByteBuffer
import org.xml.sax.InputSource
import javax.xml.parsers.DocumentBuilderFactory

/** Clerk Android 1.3.0's serialized client shape. Never returns provider data. */
internal object ClerkPersistenceInspection {
  fun verdict(ready: Boolean, account: Boolean = false, unidentified: Boolean = false, auth: Boolean = false) = mapOf(
    "format" to 1, "ready" to ready, "hasAccount" to account,
    "hasUnidentifiedSession" to unidentified, "hasAuthenticationSnapshot" to auth
  )

  fun inspectSnapshots(accountId: String, read: () -> List<ByteArray?>, decrypt: (String) -> String): Map<String, Any> = try {
    val before = read()
    require(before.size == 2)
    val results = before.map { bytes -> inspect(bytes?.let(::cacheValue)?.let(decrypt), accountId) }
    val after = read()
    require(before.size == after.size && before.indices.all { before[it].contentEquals(after[it]) })
    verdict(
      ready = results.all { it["ready"] == true },
      account = results.any { it["hasAccount"] == true },
      unidentified = results.any { it["hasUnidentifiedSession"] == true },
      auth = results.any { it["hasAuthenticationSnapshot"] == true }
    )
  } catch (_: Exception) { verdict(false) }

  fun inspect(json: String?, accountId: String): Map<String, Any> {
    if (json == null) return verdict(true)
    return try {
      val state = JSONObject(json)
      val client = state.getJSONObject("client")
      val allowed = setOf("id", "sign_in", "sign_up", "sessions", "last_active_session_id", "last_authentication_strategy", "updated_at")
      require(client.keys().asSequence().all { it in allowed })
      // Kotlin omits the default empty sessions list when serializing a client.
      val sessions = if (client.has("sessions")) client.getJSONArray("sessions") else org.json.JSONArray()
      var account = false
      var unidentified = false
      for (index in 0 until sessions.length()) {
        val session = sessions.getJSONObject(index)
        val user = session.optJSONObject("user")
        val id = user?.opt("id")
        if (id !is String || !id.matches(Regex("^user_[A-Za-z0-9_-]{1,200}$"))) unidentified = true
        if (id == accountId) account = true
      }
      verdict(true, account, unidentified, !client.isNull("sign_in") || !client.isNull("sign_up"))
    } catch (_: Exception) { verdict(false) }
  }

  /** Read the on-disk XML, not SharedPreferences' potentially newer memory view.
   * No external entities, duplicate cache entries or non-string cache values. */
  fun cacheValue(xml: ByteArray): String? {
    val text = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(xml)).toString()
    require(!text.contains("<!DOCTYPE") && !text.contains('\u0000'))
    val factory = DocumentBuilderFactory.newInstance()
    factory.isExpandEntityReferences = false
    val builder = factory.newDocumentBuilder()
    builder.setErrorHandler(object : ErrorHandler {
      override fun warning(error: SAXParseException) { throw error }
      override fun error(error: SAXParseException) { throw error }
      override fun fatalError(error: SAXParseException) { throw error }
    })
    val root = builder.parse(InputSource(StringReader(text))).documentElement
    require(root.tagName == "map")
    var found = false
    var value: String? = null
    for (index in 0 until root.childNodes.length) {
      val child = root.childNodes.item(index)
      if (child is org.w3c.dom.Element && child.getAttribute("name") == "CACHED_CLERK_STATE") {
        require(!found && child.tagName == "string")
        require((0 until child.childNodes.length).none { child.childNodes.item(it) is org.w3c.dom.Element })
        found = true
        value = child.textContent
      }
    }
    return value
  }
}
