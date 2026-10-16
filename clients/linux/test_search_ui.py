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

    def test_linux_unknown_state_asks_whether_the_game_is_closed(self):
        self.app.client = lambda *args, **kwargs: [["runtime", "unknown"]]
        notices = []
        self.app.menu = lambda title, buttons, **kwargs: notices.append((title, buttons, kwargs)) or 0
        self.assertTrue(self.app.journey_close_notice())
        self.assertEqual(notices[0][1], ["Yes, continue", "Cancel"])
        self.assertIn("would write its old save", notices[0][2]["info"][0])

    def test_a_uses_a_slot_at_once_and_returns_to_the_slots(self):
        current = ["first"]
        menus = []
        commands = []
        encode = lambda value: base64.b64encode(value.encode()).decode()
        def client(*args, **kwargs):
            commands.append(args)
            if args[1] == "switch":
                current[0] = args[3]
                return [["Current slot: Challenge · waiting to sync"]]
            return [["active", current[0], "1"], ["journey", "first", "1", encode("Main"), "2026-10-15T12:00:00Z"],
                    ["journey", "second", "1", encode("Challenge"), "2026-10-15T13:00:00Z"],
                    ["slot", "first", "1"], ["slot", "second", "2"], ["cached", "first"], ["cached", "second"],
                    ["pending-sync", "second"]]
        def menu(title, labels, **kwargs):
            menus.append((title, kwargs))
            if "slots" in kwargs:
                if current[0] == "first":
                    return 1
                self.assertEqual(kwargs["start"], 1)
                self.assertEqual(kwargs["slots"][1][2], "IN USE")
                self.assertIn("2026", kwargs["slots"][1][1])
                self.assertIn("waiting to sync", kwargs["slots"][1][1])
                self.assertIn("Now using Challenge", kwargs["info"][-1][1])
                return None
            return 0
        self.app.client = client
        self.app.menu = menu
        self.app.journey_close_notice = lambda: True
        self.app.message = lambda *args, **kwargs: self.fail("Success must not open a blocking message")
        self.app.journey_slots("identity", "Power Quest", lambda value: base64.b64decode(value).decode())
        self.assertEqual(commands[-1], ("journeys", "list", "identity", "cached"))
        self.assertEqual(len(menus), 2)

    def test_x_opens_a_slots_options(self):
        encode = lambda value: base64.b64encode(value.encode()).decode()
        self.app.client = lambda *args, **kwargs: [["active", "first", "1"], ["journey", "first", "1", encode("Main"), ""],
                                                   ["journey", "second", "1", encode("Challenge"), ""], ["cached", "first"], ["cached", "second"]]
        titles = []
        def menu(title, labels, **kwargs):
            titles.append((title, labels))
            if "slots" in kwargs:
                if len(titles) > 1:
                    return None
                self.app.menu_key = "x"
                return 1
            return None
        self.app.menu = menu
        self.app.journey_slots("identity", "Power Quest", lambda value: base64.b64decode(value).decode())
        self.assertEqual(titles[1], ("Slot 02 · Challenge", ["Use this slot", "Rename"]))


if __name__ == "__main__":
    unittest.main()
