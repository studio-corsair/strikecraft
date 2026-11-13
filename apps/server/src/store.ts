// Where broker keys and settings live on the user's machine: one JSON file readable only by the
// user (mode 0600, in a 0700 directory). Nothing in here is ever sent anywhere except a broker
// credential to its own broker, by that broker's adapter.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SavedState, StateStore } from '@strikebench/data';

export const defaultDataDir = () => process.env.STRIKEBENCH_HOME ?? path.join(os.homedir(), '.strikebench');

const EMPTY: SavedState = { connections: [], settings: { allowLiveOrders: false } };

export function fileStore(dir = defaultDataDir()): StateStore & { file: string } {
  const file = path.join(dir, 'config.json');
  return {
    file,
    async load() {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY); // error-ok: first run has no config yet
        throw e;
      }
      const j = JSON.parse(text) as Partial<SavedState>;
      return {
        connections: Array.isArray(j.connections) ? j.connections : [],
        // Live trading never survives a malformed file: anything but an explicit true is off.
        settings: { allowLiveOrders: j.settings?.allowLiveOrders === true },
      };
    },
    async save(s) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      // Write to a temp file with the right mode first, then rename: the key never exists on disk
      // with wider permissions, and a crash cannot leave a half-written config.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    },
  };
}
