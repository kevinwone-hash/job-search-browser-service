/**
 * ATS adapter registry.
 *
 * Adapters register themselves here. The runner calls adapterRegistry.find(url)
 * to select the right adapter for a given ATS URL.
 *
 * Adding a new ATS: implement ATSAdapter, import it here, add to ADAPTERS.
 */

import type { ATSAdapter } from "../types.js";
import { GreenhouseAdapter } from "./greenhouse.js";
import { LeverAdapter } from "./lever.js";
import { WorkdayAdapter } from "./workday.js";

const ADAPTERS: ATSAdapter[] = [
  new GreenhouseAdapter(),
  new LeverAdapter(),
  new WorkdayAdapter(),  // Decision 42 — proactive build authorized 2026-05-27
  // Future: new IcimsAdapter(),
];

export const adapterRegistry = {
  find(atsUrl: string): ATSAdapter | undefined {
    return ADAPTERS.find((a) => a.canHandle(atsUrl));
  },

  list(): string[] {
    return ADAPTERS.map((a) => a.platform);
  },
};
