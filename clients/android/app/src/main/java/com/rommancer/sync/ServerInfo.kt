package com.rommancer.sync

import org.json.JSONObject

/**
 * What the linked server offers (GET /api/v1/version, backend/src/lib/version.ts). The app can be newer than its
 * server (installed from elsewhere, or the server not updated yet): before using something a server gained later,
 * check has("name") and leave it out when the server lacks it. A server from before 1.98 has no such route: protocol 0,
 * no features.
 */
data class ServerInfo(val version: String?, val protocol: Int, val features: Set<String>) {
    fun has(feature: String) = feature in features

    /** Older than the server this app was built with */
    val older get() = protocol < PROTOCOL

    companion object {
        /** The protocol of the server this app was built with */
        const val PROTOCOL = 1

        /** The last answer, for code that must not wait for the network */
        @Volatile var last: ServerInfo? = null

        fun fetch(store: Store): ServerInfo? = runCatching {
            val j = JSONObject(Api(store.server).text("/version"))
            val f = j.optJSONArray("features")
            ServerInfo(j.optString("version").ifEmpty { null }, j.optInt("protocol", 0), (0 until (f?.length() ?: 0)).map { f!!.getString(it) }.toSet())
        }.recoverCatching { e -> if (e is ApiException && e.status == 404) ServerInfo(null, 0, emptySet()) else throw e }
            .getOrNull()
            ?.also { last = it }
    }
}
