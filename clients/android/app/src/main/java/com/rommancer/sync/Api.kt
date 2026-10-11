package com.rommancer.sync

import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.Base64

class ApiException(val status: Int, message: String) : Exception(message)

/** Rommancer's console endpoints: plain text "key<TAB>value" lines, device token in a header. */
class Api(private val server: String, private val token: String? = null) {

    private fun open(path: String, method: String, headers: Map<String, String>): HttpURLConnection {
        val conn = URL(server.trimEnd('/') + "/api/v1" + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 10_000
        conn.readTimeout = 120_000
        token?.let { conn.setRequestProperty("X-Device-Token", it) }
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        return conn
    }

    /**
     * Lets the connection go back to the pool (disconnect() closed it, and every rom then paid a new connection and
     * TLS handshake): bodies are read whole and closed; one read halfway is closed by its stream
     */
    private fun keep(conn: HttpURLConnection) {
        runCatching { conn.errorStream?.close() }
    }

    private fun check(conn: HttpURLConnection) {
        val code = conn.responseCode
        if (code !in 200..299) {
            val body = conn.errorStream?.bufferedReader()?.readText().orEmpty()
            val msg = Regex("\"error\"\\s*:\\s*\"([^\"]*)\"").find(body)?.groupValues?.get(1) ?: body.ifBlank { "HTTP $code" }
            throw ApiException(code, msg)
        }
    }

    fun text(path: String, method: String = "GET", body: ByteArray? = null, headers: Map<String, String> = emptyMap()): String {
        val conn = open(path, method, headers)
        try {
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body) }
            }
            check(conn)
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            keep(conn)
        }
    }

    fun form(path: String, fields: Map<String, String>): Map<String, String> {
        val body = fields.entries.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }.toByteArray()
        return pairs(text(path, "POST", body, mapOf("Content-Type" to "application/x-www-form-urlencoded")))
    }

    /** BEFORE runs once the new file is whole beside the target, before it takes its place */
    /** CANCELLED is asked between blocks: a transfer stopped on screen ends there (the partial file is dropped) */
    fun download(path: String, headers: Map<String, String>, target: File, cancelled: () -> Boolean = { false }, before: ((File) -> Unit)? = null) {
        val conn = open(path, "GET", headers)
        try {
            check(conn)
            target.parentFile?.mkdirs()
            val tmp = File(target.path + ".rommancer-tmp")
            conn.inputStream.use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (cancelled()) { out.close(); tmp.delete(); error("stopped") }
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                    }
                }
            }
            before?.invoke(tmp)
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
        } finally {
            keep(conn)
        }
    }

    /** A GET whose body is binary; null when the server answers 204 (nothing to send) */
    fun bytes(path: String, headers: Map<String, String>): ByteArray? {
        val conn = open(path, "GET", headers)
        try {
            check(conn)
            if (conn.responseCode == 204) return null
            return conn.inputStream.use { it.readBytes() }
        } finally {
            keep(conn)
        }
    }

    /** Streams a file as the request body (roms can be large) */
    /** SENT hears the bytes written so far */
    fun uploadFile(path: String, file: File, headers: Map<String, String> = emptyMap(), sent: (Long) -> Unit = {}): String {
        val conn = open(path, "POST", headers)
        try {
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(file.length())
            file.inputStream().use { input ->
                conn.outputStream.use { out ->
                    val buf = ByteArray(1 shl 16)
                    var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        total += n
                        sent(total)
                    }
                }
            }
            check(conn)
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            keep(conn)
        }
    }

    companion object {
        fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
        fun b64(s: String): String = Base64.getEncoder().encodeToString(s.toByteArray())
        fun pairs(text: String): Map<String, String> =
            text.lines().mapNotNull { line -> line.split('\t', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
    }
}
