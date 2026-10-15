import unittest
from local_library import library_rows, matches, page_target, page_bindings


class LocalLibraryTests(unittest.TestCase):
    games = [("game", "emerald", "Pokémon Emerald.gba", "gba"),
             ("game", "red", "Pokemon Red.gb", "gb"),
             ("game", "zelda", "The Legend of Zelda.nes", "nes")]

    def test_consoles_before_games(self):
        rows = library_rows(self.games)
        self.assertEqual({r[0] for r in rows}, {"system"})
        self.assertEqual(len(rows), 3)
        self.assertEqual(library_rows(self.games, "gba")[0][1], "emerald")

    def test_global_search_and_system_search(self):
        self.assertEqual({r[1] for r in library_rows(self.games, query="pokemon")}, {"emerald", "red"})
        self.assertEqual([r[1] for r in library_rows(self.games, "gba", "pokemon")], ["emerald"])
        self.assertEqual(library_rows(self.games, "gba", "zelda"), [])
        self.assertTrue(any(r[0] == "system" for r in library_rows(self.games, query="advance")))
        self.assertTrue(matches("emerald poke", "Pokémon Emerald"))

    def test_paging_boundaries_and_empty_results(self):
        self.assertEqual(page_target(2, 1, 23, 5), 5)
        self.assertEqual(page_target(20, 1, 23, 5), 22)
        self.assertEqual(page_target(22, -1, 23, 5), 15)
        self.assertEqual(page_target(0, -1, 23, 5), 0)
        self.assertEqual(page_target(0, 1, 0, 5), 0)

    def test_emulationstation_shoulder_names(self):
        mapping = page_bindings({"leftshoulder": ("button", 8, 1), "rightshoulder": ("button", 9, 1), "a": ("button", 1, 1)})
        self.assertEqual(mapping["pageup"], ("button", 8, 1))
        self.assertEqual(mapping["pagedown"], ("button", 9, 1))
        self.assertEqual(mapping["a"], ("button", 1, 1))


if __name__ == "__main__":
    unittest.main()
