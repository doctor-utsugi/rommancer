/**
 * Every route the API answers, as "METHOD /api/v1/path" lines. Express 5 keeps no mount paths, so Router.use is wrapped
 * to note them before the app is made.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Router from 'router';

type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] }; mountPath?: string };

const proto = (Router as unknown as { prototype: { use: (...a: unknown[]) => unknown; stack: Layer[] } }).prototype;
const use = proto.use;
proto.use = function (this: { stack: Layer[] }, ...args: unknown[]) {
  const before = this.stack.length;
  const r = use.apply(this, args);
  const mount = typeof args[0] === 'string' ? args[0] : '/';
  for (const l of this.stack.slice(before)) l.mountPath = mount;
  return r;
};

export async function apiRoutes(): Promise<string[]> {
  // Importing the app makes its secrets and folders: somewhere thrown away, not the working tree
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rommancer-routes-'));
  const { createApp } = await import('../src/app.js');
  const app = createApp() as unknown as { router: { stack: Layer[] } };
  const out = new Set<string>();
  const walk = (stack: Layer[], prefix: string) => {
    for (const l of stack) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.add(`${m.toUpperCase()} ${(prefix + l.route.path).replace(/\/+/g, '/')}`);
      else if (l.handle?.stack) walk(l.handle.stack, prefix + (l.mountPath && l.mountPath !== '/' ? l.mountPath : ''));
    }
  };
  walk(app.router.stack, '');
  return [...out].sort();
}
