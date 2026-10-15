package com.rommancer.sync

import org.junit.Assert.*
import org.junit.Test

class LocalLibraryTest {
    @Test fun localSearchIgnoresAccentsAndWordOrder() {
        assertTrue(LocalLibrary.matches("emerald poke", "Pokémon Emerald.gba"))
        assertTrue(LocalLibrary.matches("game advance", LocalLibrary.systemName("gba")))
        assertFalse(LocalLibrary.matches("zelda", "Pokemon Red"))
        assertTrue(LocalLibrary.matches("", "Any game"))
    }
    @Test fun pagesClampAtBothEndsAndHandleEmptyLists() {
        assertEquals(1, LocalLibrary.page(0, 1, 23, 5))
        assertEquals(4, LocalLibrary.page(4, 1, 23, 5))
        assertEquals(3, LocalLibrary.page(4, -1, 23, 5))
        assertEquals(0, LocalLibrary.page(0, -1, 23, 5))
        assertEquals(0, LocalLibrary.page(0, 1, 0, 5))
    }
}
