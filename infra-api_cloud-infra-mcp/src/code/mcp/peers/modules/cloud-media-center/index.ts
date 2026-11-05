import type { AppModule } from "../../registry.js";

/**
 * Cloud Media Center.
 *
 * No routes beyond the contract yet — this app serves what libs:devtools
 * AppDebugServer gives every member and nothing more. When its Kotlin calls
 * AppDebugServer.route("<group>", ...), list the ops here in the same change:
 * the phone is the truth, and a catalog that lags it is worse than an empty
 * one because it is believed.
 */
const mod: AppModule = {
  id: "cloud-media-center",
  pkg: "com.diegonmarcos.mediacenter",
  label: "Cloud Media Center",
  routes: [],
};

export default mod;
