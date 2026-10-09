import type { StoreFs } from "../../src/tools/pipeline-pending.js";

export interface MemFs extends StoreFs {
  files: Map<string, string>;
  renames: number;
  mkdtemp(prefix: string): Promise<string>;
}

/** In-memory fs with the same failure shapes as node:fs (ENOENT carries a code). */
export function memFs(opts: { failRename?: boolean } = {}): MemFs {
  const files = new Map<string, string>();
  let seq = 0;
  const fs: MemFs = {
    files,
    renames: 0,
    async readFile(p: string) {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT: " + p), { code: "ENOENT" });
      return v;
    },
    async writeFile(p: string, d: string) {
      files.set(p, d);
    },
    async rename(a: string, b: string) {
      if (opts.failRename) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      const v = files.get(a);
      if (v === undefined) throw Object.assign(new Error("ENOENT: " + a), { code: "ENOENT" });
      files.delete(a);
      files.set(b, v);
      fs.renames++;
    },
    async mkdir() {},
    async rm(p: string) {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(p + "/")) files.delete(k);
    },
    async mkdtemp(prefix: string) {
      seq++;
      return prefix + seq;
    },
  };
  return fs;
}
