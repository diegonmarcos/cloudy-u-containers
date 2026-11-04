// Pure (import-free) so node --experimental-strip-types tests can load it.
export const SSH_BASE_OPTS = (connectTimeout: number | string) => [
  "-o", "BatchMode=yes",
  "-o", "UserKnownHostsFile=/dev/null",
  // ...which makes every host "new", so accept-new logs a Warning each time.
  // ERROR keeps real failures (auth, timeout) and drops that noise.
  "-o", "LogLevel=ERROR",
  "-o", `ConnectTimeout=${connectTimeout}`,
];

// One argv builder for exec AND the reachability probe, so the two can never
// diverge again (check used ConnectTimeout=5 and a bare `echo ok`, exec used
// 10s + the bash wrap; fleet SSH is mesh-only via the ssh_alias, never the
// public ip).
export function sshArgv(alias: string, wrappedCommand: string, connectTimeout: number | string = 10): string[] {
  return [...SSH_BASE_OPTS(connectTimeout), alias, wrappedCommand];
}

// Address shown for a VM: the mesh address ssh actually uses, not the public ip.
export function vmMeshAddress(vm: { ip: string; wg_ip?: string }): string {
  return vm.wg_ip ?? vm.ip;
}

