import type { LoginAdapter } from "../types.js";

/** Filled in by the Google adapter commit. */
export const googleAdapter: LoginAdapter = {
  id: "google",
  title: "Google (Gmail + Calendar)",
  targets: [],
  start: async () => ({ html: "Not built yet." }),
  finish: async () => ({ ok: false, html: "Not built yet." }),
  status: async () => [],
};
