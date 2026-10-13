// LaunchBox and Big Box plugin installed by the Rommancer desktop app: before a game starts it asks the app to bring
// the game's saves up to date (and to ask about conflicts), and tells it when the game ends so its saves go up.
using System;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Unbroken.LaunchBox.Plugins;
using Unbroken.LaunchBox.Plugins.Data;

namespace Rommancer.LaunchBox
{
    public class GameHook : IGameLaunchingPlugin
    {
        private static readonly HttpClient Http = new HttpClient();
        private string playing;

        [DllImport("user32.dll")]
        private static extern bool AllowSetForegroundWindow(int processId);

        // The app writes its port and key at every start (LocalAppData\Rommancer\hook.json)
        private static (int port, string key)? Hook()
        {
            try
            {
                var file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Rommancer", "hook.json");
                var text = File.ReadAllText(file);
                var port = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
                var key = Regex.Match(text, "\"key\"\\s*:\\s*\"([0-9a-f]+)\"");
                if (!port.Success || !key.Success) return null;
                return (int.Parse(port.Groups[1].Value), key.Groups[1].Value);
            }
            catch
            {
                return null;
            }
        }

        // LaunchBox keeps paths relative to its own folder (this plugin sits in LaunchBox\Plugins\Rommancer)
        private static string FullPath(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || Path.IsPathRooted(path)) return path;
            var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(GameHook).Assembly.Location));
            while (dir != null && !string.Equals(dir.Name, "Plugins", StringComparison.OrdinalIgnoreCase)) dir = dir.Parent;
            var root = dir?.Parent?.FullName ?? AppDomain.CurrentDomain.BaseDirectory;
            return Path.GetFullPath(Path.Combine(root, path));
        }

        private static void Send(string what, string rom, TimeSpan wait)
        {
            var hook = Hook();
            if (hook == null || string.IsNullOrEmpty(rom)) return;
            try
            {
                using (var req = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{hook.Value.port}{what}") { Content = new StringContent(rom, Encoding.UTF8, "text/plain") })
                using (var cts = new System.Threading.CancellationTokenSource(wait))
                {
                    req.Headers.Add("X-Rommancer-Key", hook.Value.key);
                    Http.SendAsync(req, cts.Token).ConfigureAwait(false).GetAwaiter().GetResult().Dispose();
                }
            }
            catch
            {
                // The app is closed or did not answer in time: the game starts with the save it has
            }
        }

        public void OnBeforeGameLaunching(IGame game, IAdditionalApplication app, IEmulator emulator)
        {
            if (emulator == null) return;
            playing = FullPath(app?.ApplicationPath ?? game?.ApplicationPath);
            // Its conflict screen may come to the front over LaunchBox
            try { AllowSetForegroundWindow(-1); } catch { }
            Send("/game-start", playing, TimeSpan.FromMinutes(4));
        }

        public void OnAfterGameLaunched(IGame game, IAdditionalApplication app, IEmulator emulator) { }

        public void OnGameExited()
        {
            var rom = playing;
            playing = null;
            if (rom != null) System.Threading.Tasks.Task.Run(() => Send("/game-end", rom, TimeSpan.FromSeconds(10)));
        }
    }
}
