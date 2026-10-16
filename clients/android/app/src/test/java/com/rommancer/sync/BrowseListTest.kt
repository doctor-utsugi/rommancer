package com.rommancer.sync

import org.junit.Assert.*
import org.junit.Test

class BrowseListTest {
    private fun rows(text: String) = text.lines().filter { it.isNotBlank() }.map { it.split('\t') }

    private val check = "need\t1000\t2\nhave\t1\npending\t0\nspace\t5000\t6000\t1000\nfits\t1\n"

    @Test fun checkCarriesTheSuggestedListName() {
        val c = SyncEngine.checkOf(rows(check + "listname\tSuper Nintendo · 16 Oct\n"))
        assertEquals("Super Nintendo · 16 Oct", c.listName)
        assertEquals(2, c.needGames)
        assertTrue(c.fits)
        assertNull(SyncEngine.checkOf(rows(check)).listName)
    }

    @Test fun listsKeepTheServerOrder() {
        val lists = SyncEngine.browseListsOf(rows("list\t3\t12\tFavourites\nlist\t9\t0\tRPGs\n"))
        assertEquals(listOf(SyncEngine.BrowseList(3, 12, "Favourites"), SyncEngine.BrowseList(9, 0, "RPGs")), lists)
        assertTrue(SyncEngine.browseListsOf(rows("nolists\n")).isEmpty())
    }

    @Test fun savedListAndRefusals() {
        val saved = SyncEngine.savedOf(rows(check + "list\t42\t3\t5\t0\tMy games · 16 Oct\n"))
        assertNull(saved.refused)
        assertEquals(42, saved.id)
        assertEquals(3, saved.added)
        assertEquals(5, saved.games)
        assertFalse(saved.onDevice)
        assertEquals("My games · 16 Oct", saved.name)
        assertEquals(2, saved.check.needGames)

        val nospace = SyncEngine.savedOf(rows(check.replace("fits\t1", "fits\t0") + "nospace\n"))
        assertEquals("nospace", nospace.refused)
        assertTrue(nospace.check.nospace)
        assertEquals("nolist", SyncEngine.savedOf(rows(check + "nolist\n")).refused)
        assertEquals("nolists", SyncEngine.savedOf(rows("nolists\n")).refused)
        assertEquals("empty", SyncEngine.savedOf(rows(check + "empty\n")).refused)
    }
}
