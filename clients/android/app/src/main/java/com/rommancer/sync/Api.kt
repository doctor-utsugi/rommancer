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
            return conn.inputStream.bufferedReader().readText()
        } finally {
            conn.disconnect()
        }
    }

    fun form(path: String, fields: Map<String, String>): Map<String, String> {
        val body = fields.entries.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }.toByteArray()
        return pairs(text(path, "POST", body, mapOf("Content-Type" to "application/x-www-form-urlencoded")))
    }

    fun download(path: String, headers: Map<String, String>, target: File) {
        val conn = open(path, "GET", headers)
        try {
            check(conn)
            target.parentFile?.mkdirs()
            val tmp = File(target.path + ".rommancer-tmp")
            conn.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
        } finally {
            conn.disconnect()
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
            conn.disconnect()
        }
    }

    /** Streams a file as the request body (roms can be large) */
    fun uploadFile(path: String, file: File, headers: Map<String, String> = emptyMap()): String {
        val conn = open(path, "POST", headers)
        try {
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(file.length())
            file.inputStream().use { input -> conn.outputStream.use { input.copyTo(it, 1 shl 16) } }
            check(conn)
            return conn.inputStream.bufferedReader().readText()
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
        fun b64(s: String): String = Base64.getEncoder().encodeToString(s.toByteArray())
        fun pairs(text: String): Map<String, String> =
            text.lines().mapNotNull { line -> line.split('\t', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
    }
}
