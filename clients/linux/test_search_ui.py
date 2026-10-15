import base64
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

os.environ["SDL_VIDEODRIVER"] = "dummy"
os.environ["SDL_AUDIODRIVER"] = "dummy"
import pygame
from local_library import LocalSearch

spec = importlib.util.spec_from_file_location("sync_ui", Path(__file__).with_name("rommancer-ui.py"))
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)


class SearchUiTests(unittest.TestCase):
    def setUp(self):
        self.app = ui.App.__new__(ui.App)
        self.app.screen = ui.Screen()
        self.app.clock = pygame.time.Clock()
        self.app.browse_all = False
        self.app.in_thread = lambda work, *args: work()

    def tearDown(self):
        pygame.quit()

    def test_local_search_does_no_work_until_keyboard_accept(self):
        encode = lambda value: base64.b64encode(value.encode()).decode()
        self.app.client = lambda *args, **kwargs: [
            ["game", encode("/Pokemon.gba"), encode("Pokemon.gba"), "gba"],
            ["game", encode("/Zelda.nes"), encode("Zelda.nes"), "nes"],
        ]
        actions = iter(["y", ("char", "p"), ("char", "oke"), None, "up", "a", "b"])
        accepted = []
        original = LocalSearch.accept

        def apply(search, draft):
            accepted.append(draft)
            return original(search, draft)

        def next_action(*args, **kwargs):
            action = next(actions, "b")
            if action != "b":
                self.assertEqual(accepted, [], "Typing or idle frames applied a query")
            return action

        self.app.next_action = next_action
        with patch.object(LocalSearch, "accept", apply):
            self.app.journeys()
        self.assertEqual(accepted, ["poke"])

    def test_keyboard_accept_keeps_special_characters(self):
        actions = iter([("char", "test*~"), "up", "a"])
        self.app.next_action = lambda *args, **kwargs: next(actions, "quit")
        self.assertEqual(self.app.keyboard("Slot name"), "test*~")

    def test_remote_search_waits_for_accept(self):
        self.app.search_gen = 0
        self.app.picks_foot = lambda *args: None
        queries = []
        actions = iter([("char", "p"), ("char", "oke"), None, "up", "a", "b"])

        def paged(app, slug, query="", **kwargs):
            queries.append(query)
            return SimpleNamespace(rows=[], total=0, failed=False, denied=False, loading=False,
                                   query=query, show_all=False, load=lambda: None)

        def next_action(*args, **kwargs):
            action = next(actions, "b")
            if action != "b":
                self.assertEqual(queries, [], "Typing started a server search")
            return action

        self.app.next_action = next_action
        with patch.object(ui, "Paged", paged):
            self.app.browse_games(SimpleNamespace(), {})
        self.assertEqual(queries, ["poke"])

    def test_linux_closed_game_needs_no_notice(self):
        self.app.client = lambda *args, **kwargs: [["runtime", "stopped"]]
        self.app.menu = lambda *args, **kwargs: self.fail("A known stopped emulator should not need a warning")
        self.assertTrue(self.app.journey_close_notice())

    def test_linux_unknown_state_shows_plain_ok_warning(self):
        self.app.client = lambda *args, **kwargs: [["runtime", "unknown"]]
        notices = []
        self.app.menu = lambda title, buttons, **kwargs: notices.append((title, buttons, kwargs)) or 0
        self.assertTrue(self.app.journey_close_notice())
        self.assertEqual(notices[0][1], ["OK", "Cancel"])
        self.assertIn("If the emulator is open", notices[0][2]["info"][0])


if __name__ == "__main__":
    unittest.main()
