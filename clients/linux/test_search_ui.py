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

    def review_app(self, check, actions, saved=None, lists=()):
        """The app set up for browse_review: CHECK the check's extra lines, ACTIONS the pad's, SAVED the browse-list
        answer; the shell commands and the download recorded"""
        os.makedirs(ui.work_dir(), exist_ok=True)
        calls = []

        def client(*args, **kwargs):
            body = Path(args[1]).read_text(encoding="utf-8") if len(args) > 1 else ""
            calls.append((args[0], body))
            if args[0] == "browse-check":
                return [["have", "0"], ["pending", "0"], ["space", "900000000", "1000000000", "100000000"]] + check
            if args[0] == "browse-lists":
                return [["list", l[0], str(l[1]), l[2]] for l in lists]
            if args[0] == "browse-list":
                return [["fits", "1"], saved]
            return None

        steps = iter(actions)
        self.app.client = client
        self.app.next_action = lambda *args, **kwargs: next(steps, "quit")
        self.app.run_with_progress = lambda *args: calls.append(("progress", args[0]))
        picks = ui.Picks()
        picks.toggle("g1", 10, "snes")
        picks.toggle("g2", 20, "snes")
        return picks, calls

    def test_review_offers_the_list_actions_when_the_server_names_one(self):
        cases = [
            ([["need", "30", "2"], ["fits", "1"], ["listname", "Super Nintendo · 16 Oct"]], ["Download", "Save as a new list", "Add to a list…", "Cancel"], "Download 2 games"),
            ([["need", "0", "0"], ["fits", "1"], ["listname", "Super Nintendo · 16 Oct"]], ["Save as a new list", "Add to a list…", "Cancel"], "All these games are on this console already"),
            ([["need", "30", "2"], ["fits", "0"], ["listname", "Super Nintendo · 16 Oct"]], ["Save as a new list", "Add to a list…", "Cancel"], "Not enough space"),
            ([["need", "30", "2"], ["fits", "1"]], ["Download", "Cancel"], "Download 2 games"),
        ]
        for check, labels, first in cases:
            picks, _ = self.review_app(check, [])
            menus = []
            self.app.menu = lambda title, items, **kwargs: menus.append((items, kwargs["info"])) and None
            self.assertIsNone(self.app.browse_review(picks, {}))
            self.assertEqual(menus[0][0], labels)
            line = menus[0][1][0]
            self.assertIn(first, line if isinstance(line, str) else line[1])

    def test_save_as_a_new_list_opens_the_keyboard_with_the_name_typed(self):
        check = [["need", "30", "2"], ["fits", "1"], ["listname", "Super Nintendo · 16 Oct"]]
        saved = ["list", "L9", "2", "2", "0", "Super Nintendo · 16 Oct"]
        # Save as a new list, accept the typed name at once, then Done
        picks, calls = self.review_app(check, ["down", "a", "start", "down", "a"], saved)
        self.assertIsNone(self.app.browse_review(picks, {}))
        self.assertEqual([c[0] for c in calls], ["browse-check", "browse-list"])
        self.assertIn("name\tSuper Nintendo · 16 Oct\n", calls[1][1])
        self.assertIn("game\tg1\n", calls[1][1])
        self.assertFalse(picks, "A saved selection is cleared")

    def test_an_emptied_name_falls_back_to_the_suggestion(self):
        check = [["need", "0", "0"], ["fits", "1"], ["listname", "My games · 16 Oct"]]
        saved = ["list", "L9", "2", "2", "0", "My games · 16 Oct"]
        picks, calls = self.review_app(check, ["a"] + ["b"] * 30 + ["start", "a"], saved)
        self.assertIsNone(self.app.browse_review(picks, {}))
        self.assertIn("name\tMy games · 16 Oct\n", calls[1][1])

    def test_a_typed_name_is_kept(self):
        check = [["need", "0", "0"], ["fits", "1"], ["listname", "My games · 16 Oct"]]
        saved = ["list", "L9", "2", "2", "0", "My games · 16 Oct!"]
        picks, calls = self.review_app(check, ["a", ("char", "!"), "start", "a"], saved)
        self.app.browse_review(picks, {})
        self.assertIn("name\tMy games · 16 Oct!\n", calls[1][1])

    def test_add_to_a_list_on_the_console_downloads_at_once(self):
        check = [["need", "30", "2"], ["fits", "1"], ["listname", "Super Nintendo · 16 Oct"]]
        saved = ["list", "L2", "1", "2", "1", "RPGs"]
        lists = [("FAV", 40, "Favourites"), ("L2", 12, "RPGs")]
        messages = []
        # Add to a list…, the second list
        picks, calls = self.review_app(check, ["down", "down", "a", "down", "a"], saved, lists)
        self.app.message = lambda text, *args, **kwargs: messages.append(text)
        self.assertEqual(self.app.browse_review(picks, {}), "done")
        self.assertEqual([c[0] for c in calls], ["browse-check", "browse-lists", "browse-list", "progress"])
        self.assertIn("list\tL2\n", calls[2][1])
        self.assertNotIn("assign", calls[2][1])
        self.assertIn("Saved to “RPGs” · 2 games · 1 new", messages)
        self.assertFalse(picks)

    def test_a_saved_list_can_then_go_to_this_console(self):
        check = [["need", "30", "2"], ["fits", "1"], ["listname", "Super Nintendo · 16 Oct"]]
        saved = ["list", "L9", "2", "2", "0", "Super Nintendo · 16 Oct"]
        menus = []
        picks, calls = self.review_app(check, ["down", "a", "start", "a"], saved)
        real = self.app.menu
        self.app.menu = lambda title, items, **kwargs: menus.append(items) or real(title, items, **kwargs)
        self.assertEqual(self.app.browse_review(picks, {}), "done")
        self.assertEqual(menus[-1], ["Download them to this console", "Done"])
        self.assertEqual([c[0] for c in calls], ["browse-check", "browse-list", "browse-list", "progress"])
        self.assertIn("list\tL9\nassign\t1\n", calls[2][1])
        self.assertIn("game\tg2\n", calls[2][1])


if __name__ == "__main__":
    unittest.main()
