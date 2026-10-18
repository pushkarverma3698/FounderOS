/**
 * FounderOS — atomic file writes
 * ==============================
 * Leaf module (no project imports) so apply-profile.ts and candidate-dossier.ts can both use it.
 * A reader sees the old file or the new file, never half of one: write a sibling temp file, fsync, rename.
 */

import * as fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface AtomicFile {
  readonly path: string;
  readonly content: string;
}

/** Write every file to a temp sibling first, then rename them all; any failure removes the temps and leaves the targets alone. */
export async function atomicWriteMany(files: readonly AtomicFile[]): Promise<void> {
  const staged: Array<{ readonly tmp: string; readonly path: string }> = [];
  try {
    for (const f of files) {
      await fs.mkdir(dirname(f.path), { recursive: true });
      const tmp = `${f.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      staged.push({ tmp, path: f.path });
      const handle = await fs.open(tmp, "w", 0o600);
      try {
        await handle.writeFile(f.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const s of staged) await fs.rename(s.tmp, s.path);
  } catch (err) {
    await Promise.all(
      // allow-failopen: best-effort temp cleanup; the original error is rethrown right below.
      staged.map((s) => fs.rm(s.tmp, { force: true }).catch(() => undefined)),
    );
    throw err;
  }
}

/** Write one file atomically, mode 0600. */
export async function atomicWrite(path: string, content: string): Promise<void> {
  await atomicWriteMany([{ path, content }]);
}
