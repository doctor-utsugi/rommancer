// Playnite extension installed by the Rommancer desktop app: it writes Playnite's emulated games for the app (each
// rom with its platform and the emulator command it runs with, LocalAppData\Rommancer\playnite.tsv), asks the app to
// bring a game's saves up to date before it starts, and tells it when the game ends so its saves go up.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using Playnite.SDK;
using Playnite.SDK.Events;
using Playnite.SDK.Models;
using Playnite.SDK.Plugins;

namespace Rommancer.Playnite
{
    public class RommancerPlugin : GenericPlugin
    {
        private static readonly HttpClient Http = new HttpClient();
        private static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Rommancer");
        private string playing;
        private System.Threading.Timer export;

        public override Guid Id { get; } = Guid.Parse("5e0c63f1-6f86-4c47-9a3e-2d1c0b7e9a51");

        public RommancerPlugin(IPlayniteAPI api) : base(api)
        {
            Properties = new GenericPluginProperties { HasSettings = false };
        }

        // The app writes its port and key at every start (LocalAppData\Rommancer\hook.json)
        private static Tuple<int, string> Hook()
        {
            try
            {
                var text = File.ReadAllText(Path.Combine(Dir, "hook.json"));
                var port = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
                var key = Regex.Match(text, "\"key\"\\s*:\\s*\"([0-9a-f]+)\"");
                if (!port.Success || !key.Success) return null;
                return Tuple.Create(int.Parse(port.Groups[1].Value), key.Groups[1].Value);
            }
            catch
            {
                return null;
            }
        }

        private static void Send(string what, string rom, TimeSpan wait)
        {
            var hook = Hook();
            if (hook == null || string.IsNullOrEmpty(rom)) return;
            try
            {
                using (var req = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{hook.Item1}{what}") { Content = new StringContent(rom, Encoding.UTF8, "text/plain") })
                using (var cts = new System.Threading.CancellationTokenSource(wait))
                {
                    req.Headers.Add("X-Rommancer-Key", hook.Item2);
                    Http.SendAsync(req, cts.Token).ConfigureAwait(false).GetAwaiter().GetResult().Dispose();
                }
            }
            catch
            {
                // The app is closed or did not answer in time: the game starts with the save it has
            }
        }

        private static string Clean(string s) => (s ?? "").Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');

        /// The program and arguments an emulator profile runs: a custom profile's own, a built-in one's from
        /// Playnite's emulator definition (its program found in the emulator's folder)
        private Tuple<string, string> Command(Emulator emu, string profileId)
        {
            var profile = emu.GetProfile(profileId);
            var dir = emu.InstallDir ?? "";
            if (profile is CustomEmulatorProfile custom)
                return Tuple.Create(custom.Executable?.Replace("{EmulatorDir}", dir), custom.Arguments?.Replace("{EmulatorDir}", dir));
            if (profile is BuiltInEmulatorProfile builtin)
            {
                var def = PlayniteApi.Emulation.GetEmulator(emu.BuiltInConfigId)?.Profiles?.FirstOrDefault(p => p.Name == builtin.BuiltInProfileName);
                if (def == null || !Directory.Exists(dir)) return null;
                var exe = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).FirstOrDefault(f => Regex.IsMatch(f.Substring(dir.Length).TrimStart('\\', '/'), def.StartupExecutable ?? "^$", RegexOptions.IgnoreCase));
                var args = builtin.OverrideDefaultArgs ? builtin.CustomArguments : def.StartupArguments;
                return Tuple.Create(exe, args?.Replace("{EmulatorDir}", dir));
            }
            return null;
        }

        /// One line per rom of an emulated game: "game<TAB>rom<TAB>platform<TAB>program<TAB>arguments"
        private void Export()
        {
            try
            {
                var lines = new List<string>();
                var emulators = PlayniteApi.Database.Emulators.ToDictionary(e => e.Id);
                foreach (var game in PlayniteApi.Database.Games)
                {
                    var action = game.GameActions?.FirstOrDefault(a => a.Type == GameActionType.Emulator && a.IsPlayAction) ?? game.GameActions?.FirstOrDefault(a => a.Type == GameActionType.Emulator);
                    if (action == null || game.Roms == null || !emulators.TryGetValue(action.EmulatorId, out var emu)) continue;
                    var cmd = Command(emu, action.EmulatorProfileId);
                    if (cmd == null || string.IsNullOrEmpty(cmd.Item1)) continue;
                    var args = action.OverrideDefaultArgs ? action.Arguments : $"{cmd.Item2} {action.AdditionalArguments}";
                    var platform = game.Platforms?.FirstOrDefault()?.Name ?? "";
                    foreach (var rom in game.Roms)
                    {
                        var path = PlayniteApi.ExpandGameVariables(game, rom.Path ?? "");
                        if (string.IsNullOrEmpty(path)) continue;
                        lines.Add($"game\t{Clean(Path.GetFullPath(path))}\t{Clean(platform)}\t{Clean(cmd.Item1)}\t{Clean(args)}");
                    }
                }
                Directory.CreateDirectory(Dir);
                var file = Path.Combine(Dir, "playnite.tsv");
                var text = string.Join("\n", lines) + "\n";
                if (!File.Exists(file) || File.ReadAllText(file) != text)
                {
                    File.WriteAllText(file + ".tmp", text);
                    if (File.Exists(file)) File.Delete(file);
                    File.Move(file + ".tmp", file);
                }
            }
            catch
            {
                // Written again with the next change
            }
        }

        /// Written a few seconds after the last change (an import changes many games at once)
        private void ExportSoon()
        {
            if (export == null) export = new System.Threading.Timer(_ => Export());
            export.Change(TimeSpan.FromSeconds(5), System.Threading.Timeout.InfiniteTimeSpan);
        }

        public override void OnApplicationStarted(OnApplicationStartedEventArgs args)
        {
            PlayniteApi.Database.Games.ItemCollectionChanged += (s, e) => ExportSoon();
            PlayniteApi.Database.Games.ItemUpdated += (s, e) => ExportSoon();
            PlayniteApi.Database.Emulators.ItemUpdated += (s, e) => ExportSoon();
            ExportSoon();
        }

        public override void OnLibraryUpdated(OnLibraryUpdatedEventArgs args) => ExportSoon();

        public override void OnGameStarting(OnGameStartingEventArgs args)
        {
            if (args.SourceAction?.Type != GameActionType.Emulator) return;
            var rom = args.SelectedRomFile ?? args.Game?.Roms?.FirstOrDefault()?.Path;
            if (string.IsNullOrEmpty(rom)) return;
            playing = Path.GetFullPath(PlayniteApi.ExpandGameVariables(args.Game, rom));
            Send("/game-start", playing, TimeSpan.FromMinutes(4));
        }

        public override void OnGameStopped(OnGameStoppedEventArgs args)
        {
            var rom = playing;
            playing = null;
            if (rom != null) System.Threading.Tasks.Task.Run(() => Send("/game-end", rom, TimeSpan.FromSeconds(10)));
        }
    }
}
