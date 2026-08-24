import { AtsAdapter } from "./types.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { ashbyAdapter } from "./ashby.js";
import { recruiteeAdapter } from "./recruitee.js";
import { smartrecruitersAdapter } from "./smartrecruiters.js";
import { workableAdapter } from "./workable.js";
import { personioAdapter } from "./personio.js";

export const ADAPTERS: Record<string, AtsAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  recruitee: recruiteeAdapter,
  smartrecruiters: smartrecruitersAdapter,
  workable: workableAdapter,
  personio: personioAdapter,
};

export function getAdapter(platformName: string): AtsAdapter | undefined {
  return ADAPTERS[platformName];
}
