import type { AppModule } from "../../registry.js";

/**
 * Cloud-Calendar.
 *
 * No routes beyond the contract yet — this app serves what libs:devtools
 * AppDebugServer gives every member and nothing more. When its Kotlin calls
 * AppDebugServer.route("<group>", ...), list the ops here in the same change:
 * the phone is the truth, and a catalog that lags it is worse than an empty
 * one because it is believed.
 */
const mod: AppModule = {
  id: "cloud-calendar",
  pkg: "com.diegonmarcos.cloudcalendar",
  label: "Cloud-Calendar",
  routes: [],
};

export default mod;
