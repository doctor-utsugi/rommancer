package com.rommancer.sync

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.File

/**
 * Dolphin's GameCube saves. Dolphin for Android keeps its user folder in Android/data, out of reach of other apps,
 * but shares it through its own documents provider: the user grants it once in the system's folder picker. Its
 * saves go to the server under a virtual path, /dolphin-saf/<path in Dolphin's folder>, such as
 * /dolphin-saf/GC/EUR/Card A/01-G4SP-gc4sword.gci (one .gci per save: Dolphin's default GCI folders).
 * Older builds kept the folder in shared storage (dolphin-emu, mmjr-revamp): those are plain files.
 */
class Dolphin(private val context: Context, private val store: Store) {

    /** A .gci in Dolphin's folder: its virtual path, document, size and time for the hash cache */
    data class Save(val path: String, val uri: Uri, val size: Long, val modified: Long)

    private val resolver get() = context.contentResolver
    private val tree: Uri? get() = store.dolphinTree?.let(Uri::parse)?.takeIf { granted(it) }

    private fun granted(uri: Uri) = resolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission && it.isWritePermission }

    /** Whether the folder is shared with us */
    val linked: Boolean get() = tree != null

    /** Remembers the folder the user picked, for good */
    fun link(uri: Uri) {
        resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        store.dolphinTree = uri.toString()
    }

    /** Every .gci under GC/<region>/ (GCI folders), at most two folders down */
    fun saves(): List<Save> {
        val tree = tree ?: return emptyList()
        val top = DocumentsContract.getTreeDocumentId(tree)
        // The user may grant Dolphin's whole folder (the picker opens there) or GC itself
        val start = when {
            relOf(top).isEmpty() -> child(tree, top, "GC")?.first ?: return emptyList()
            relOf(top).split('/').first() == "GC" -> top
            else -> return emptyList()
        }
        val out = mutableListOf<Save>()
        fun walk(doc: String, depth: Int) {
            for (c in children(tree, doc)) {
                if (c.mime == Document.MIME_TYPE_DIR) {
                    if (depth < 2) walk(c.id, depth + 1)
                } else if (c.name.lowercase().endsWith(".gci")) {
                    out += Save(PREFIX + relOf(c.id), DocumentsContract.buildDocumentUriUsingTree(tree, c.id), c.size, c.modified)
                }
            }
        }
        walk(start, 0)
        return out
    }

    fun read(path: String): ByteArray {
        val tree = tree ?: error("Dolphin folder not shared")
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, docOf(path))
        return resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("Cannot read $path")
    }

    /**
     * Writes a save in full: a temporary file beside it (not a .gci, so Dolphin never loads it half written), then
     * the old one removed and the new one renamed into place. Missing folders are made.
     */
    fun write(path: String, data: ByteArray) {
        val tree = tree ?: error("Dolphin folder not shared")
        val rel = relOf(docOf(path))
        val name = rel.substringAfterLast('/')
        var parent = DocumentsContract.getTreeDocumentId(tree)
        for (dir in rel.removePrefix(relOf(parent)).trim('/').split('/').dropLast(1)) {
            parent = child(tree, parent, dir)?.first
                ?: DocumentsContract.createDocument(resolver, docUri(tree, parent), Document.MIME_TYPE_DIR, dir)
                    ?.let(DocumentsContract::getDocumentId) ?: error("Cannot make $dir")
        }
        val tmp = DocumentsContract.createDocument(resolver, docUri(tree, parent), "application/octet-stream", "$name.rommancer-tmp")
            ?: error("Cannot write $path")
        try {
            resolver.openOutputStream(tmp, "wt")?.use { it.write(data) } ?: error("Cannot write $path")
            child(tree, parent, name)?.let { DocumentsContract.deleteDocument(resolver, docUri(tree, it.first)) }
            DocumentsContract.renameDocument(resolver, tmp, name) ?: error("Cannot rename $path")
        } catch (e: Exception) {
            runCatching { DocumentsContract.deleteDocument(resolver, tmp) }
            throw e
        }
    }

    private data class Child(val id: String, val name: String, val mime: String, val size: Long, val modified: Long)

    private fun children(tree: Uri, doc: String): List<Child> {
        val cols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)
        val out = mutableListOf<Child>()
        resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, doc), cols, null, null, null)?.use { c ->
            while (c.moveToNext()) out += Child(c.getString(0), c.getString(1), c.getString(2) ?: "", c.getLong(3), c.getLong(4))
        }
        return out
    }

    private fun child(tree: Uri, doc: String, name: String) = children(tree, doc).firstOrNull { it.name == name }?.let { it.id to it }

    private fun docUri(tree: Uri, doc: String) = DocumentsContract.buildDocumentUriUsingTree(tree, doc)

    companion object {
        const val AUTHORITY = "org.dolphinemu.dolphinemu.user"
        private const val ROOT = "root"
        const val PREFIX = "/dolphin-saf/"

        /** Where the folder picker opens: Dolphin's user folder */
        val initialUri: Uri get() = DocumentsContract.buildDocumentUri(AUTHORITY, ROOT)

        /** Dolphin's folders in shared storage, from builds before Android/data (official and MMJR forks) */
        val legacyRoots = listOf("dolphin-emu", "mmjr-revamp", "dolphin-mmjr")

        fun installed(context: Context) = context.packageManager.resolveContentProvider(AUTHORITY, 0) != null

        fun isVirtual(path: String) = path.startsWith(PREFIX)

        /** "root/GC/EUR/x.gci" → "GC/EUR/x.gci"; the root itself is "root" or "root/" */
        private fun relOf(doc: String) = doc.removePrefix(ROOT).trimStart('/')

        private fun docOf(path: String) = "$ROOT/" + path.removePrefix(PREFIX)

        /** The .gci files of the old shared-storage folders */
        fun legacySaves(storage: File): List<File> = legacyRoots.map { File(storage, "$it/GC") }.filter { it.isDirectory }
            .flatMap { gc -> gc.walkTopDown().maxDepth(3).filter { it.isFile && it.name.lowercase().endsWith(".gci") }.toList() }
    }
}
