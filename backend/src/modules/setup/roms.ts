/**
 * The installer's last step when it runs in the browser: the folder of the computer that holds the roms. The API runs
 * in a container and only sees the folder mounted at /roms, so the choice goes to the computer: rommancer.sh's
 * watcher (the one that runs updates) starts Rommancer again with the folder chosen.
 *
 * While the step is pending (rommancer.sh install --web leaves UPDATE_DIR/choose-roms), rommancer.sh also mounts the
 * places roms usually are (ROMMANCER_BROWSE: the home folder, /mnt, /media...) read-only under /host, to browse them.
 * Once a folder is chosen they are mounted no more.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = () => process.env.UPDATE_DIR ?? '';
// Where rommancer.sh mounts the computer's folders (another place in tests)
const host = () => process.env.ROMMANCER_HOST_ROOT || '/host';
const PENDING = 'choose-roms';

/** The roms folder as the computer names it (rommancer.sh passes it), or null outside rommancer.sh */
export const romsOnHost = () => process.env.ROMMANCER_ROMS_HOST || null;

/** The folders of the computer that can be browsed: those rommancer.sh mounted under /host */
export const browseRoots = () =>
  (process.env.ROMMANCER_BROWSE ?? '')
    .split(':')
    .filter((p) => p.startsWith('/') && fs.existsSync(host() + p));

export const romsPending = () => !!dir() && fs.existsSync(path.join(dir(), PENDING));

/** Whether the computer can mount another folder: its watcher is installed (rommancer.sh service on) */
export const canChangeRoms = () => !!dir() && fs.existsSync(path.join(dir(), 'watcher')) && browseRoots().length > 0;

/** A path of the computer inside the roots that can be browsed, normalized; null otherwise */
export function hostPath(p: string): string | null {
  if (!p.startsWith('/') || /["\\\n]/.test(p)) return null;
  const n = path.posix.normalize(p).replace(/\/+$/, '') || '/';
  return browseRoots().some((r) => n === r || n.startsWith(r + '/')) ? n : null;
}

/** The folders inside one of the computer, hidden ones left out */
export function listFolders(p: string): { name: string; path: string }[] {
  return fs
    .readdirSync(host() + p, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.posix.join(p, e.name)))))
    .map((e) => ({ name: e.name, path: path.posix.join(p, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const isDir = (p: string) => {
  try {
    return fs.statSync(host() + p).isDirectory();
  } catch {
    return false;
  }
};

/** The step is done: the next start of Rommancer no longer mounts the computer's folders */
export function finishRoms() {
  if (dir()) fs.rmSync(path.join(dir(), PENDING), { force: true });
}

/** Asks the computer to start Rommancer again with this folder at /roms; the step ends with it */
export function requestRoms(p: string) {
  fs.writeFileSync(path.join(dir(), 'request.new'), `${JSON.stringify({ roms: p, at: new Date().toISOString() })}\n`);
  fs.renameSync(path.join(dir(), 'request.new'), path.join(dir(), 'request'));
}
