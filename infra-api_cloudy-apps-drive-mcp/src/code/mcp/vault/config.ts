/**
 * Configuration for personal data MCP.
 * All paths come from environment variables — no hardcoded secrets.
 */
import { join } from "path";

export function getVaultPath(): string {
  const p = process.env.VAULT_PATH;
  if (!p) throw new Error("VAULT_PATH env var not set — point it at ~/git/cloud-vault");
  return p;
}

export function getConfigPath(): string {
  const p = process.env.CONFIG_PATH;
  if (!p) throw new Error("CONFIG_PATH env var not set — point it at ~/git/cloud-t-infra/config.json");
  return p;
}

export function getGitRoot(): string {
  // Derive from vault path: vault is at ~/git/cloud-vault, so git root is ~/git/
  return join(getVaultPath(), "..");
}
