/**
 * The one rule devops.build.secrets_status has to get right:
 *
 *   "no secrets.yaml" is a claim about a FILE. It may only be returned once
 *   the service directory has been shown to exist. Every other outcome —
 *   no source tree, no service directory, a file we could not open — is
 *   UNKNOWN, never a clean negative.
 *
 * This lived inline in the tool handler and got it backwards: when the source
 * tree was not reachable at all it answered "no secrets.yaml" for all 76
 * services, every one of which had a sops-encrypted secrets.yaml on disk.
 * Believing that negative means recreating a secret that already exists, or
 * treating a configured service as unconfigured.
 *
 * Pure and dependency-free on purpose: the tool handler gathers the facts, this
 * decides the wording, and __selfcheck__.ts exercises it without a filesystem,
 * an MCP server or a network.
 */

export interface SecretsProbe {
  /** True when no declared solution root exists — one environment fault, not N findings. */
  treeMissing: boolean;
  /** Resolved service directory (named in the message so the reader can check it). */
  serviceDir: string;
  serviceDirExists: boolean;
  /**
   * Contents of src/secrets.yaml, or null when the file is not there.
   * Only the sops markers are ever looked at, and the caller must never echo
   * this value — file name and encryption status only.
   */
  secretsYamlContents: string | null;
  /** Why an existing secrets.yaml could not be read, else null. */
  readError: string | null;
}

export function describeSecretsStatus(probe: SecretsProbe): string {
  if (!probe.serviceDirExists) {
    return probe.treeMissing
      ? "UNKNOWN (source tree not checked out)"
      : `UNKNOWN (service directory not found: ${probe.serviceDir})`;
  }
  if (probe.readError !== null) {
    return `UNKNOWN (secrets.yaml present but unreadable: ${probe.readError})`;
  }
  if (probe.secretsYamlContents === null) {
    return "no secrets.yaml";
  }
  // Content-checked, never filename-trusted: a file called secrets.yaml that
  // carries no sops marker is committed plaintext, and that is the loudest
  // thing this tool can say.
  const hasSopsMarker =
    probe.secretsYamlContents.includes("sops:") ||
    probe.secretsYamlContents.includes("ENC[AES256_GCM");
  return hasSopsMarker ? "encrypted (sops)" : "PLAINTEXT WARNING";
}
