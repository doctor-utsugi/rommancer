package com.rommancer.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EsDeTest {
    private val smz3 = EsDe.Meta("/r/snes/SMZ3_popoie_fang.sfc", "SMZ3 popoie fang", "Super Metroid SMZ3 popoie fang", "")

    @Test
    fun parsesMetaLinesKeepingEmptyFields() {
        val m = EsDe.parseMeta(listOf("rom\t/r/snes/a.sfc\t1\tref", "meta\t/r/snes/a.sfc\tA & B\t\tA desc"))
        assertEquals(listOf(EsDe.Meta("/r/snes/a.sfc", "A & B", "", "A desc")), m)
    }

    @Test
    fun addsMissingEntriesOnly() {
        val list = "<?xml version=\"1.0\"?>\n<gameList>\n\t<game>\n\t\t<path>./A &amp; B.sfc</path>\n\t\t<name>Scraped</name>\n\t</game>\n</gameList>\n"
        val (text, n) = EsDe.addEntries(list, listOf("./A & B.sfc" to smz3.copy(name = "Not this"), "./SMZ3_popoie_fang.sfc" to smz3))!!
        assertEquals(1, n)
        assertTrue(text.contains("<name>Scraped</name>"))
        assertTrue(!text.contains("Not this"))
        assertTrue(text.contains("\t<game>\n\t\t<path>./SMZ3_popoie_fang.sfc</path>\n\t\t<name>SMZ3 popoie fang</name>\n\t\t<sortname>Super Metroid SMZ3 popoie fang</sortname>\n\t</game>\n</gameList>"))
        assertNull(EsDe.addEntries(text, listOf("./SMZ3_popoie_fang.sfc" to smz3)))
    }

    @Test
    fun createsTheListAndEscapes() {
        val (text, _) = EsDe.addEntries(null, listOf("./x.sfc" to EsDe.Meta("/r/snes/x.sfc", "<X> & Y", "", "d")))!!
        assertTrue(text.startsWith("<?xml"))
        assertTrue(text.contains("<name>&lt;X&gt; &amp; Y</name>\n\t\t<desc>d</desc>"))
    }

    @Test
    fun leavesAnUnreadableListAlone() {
        assertNull(EsDe.addEntries("<gameList><game>", listOf("./x.sfc" to smz3)))
    }
}
