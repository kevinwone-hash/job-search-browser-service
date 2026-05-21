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

const ADAPTERS: ATSAdapter[] = [
  new GreenhouseAdapter(),
  new LeverAdapter(),
  // Future: new WorkdayAdapter(),
  // Future: new IcimsCAdapter(),
];

export const adapterRegistry = {
  find(atsUrl: string): ATSAdapter | undefined {
    return ADAPTERS.find((a) => a.canHandle(atsUrl));
  },

  list(): string[] {
    return ADAPTERS.map((a) => a.platform);
  },
};
