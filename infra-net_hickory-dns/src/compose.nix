# compose.nix — hickory-dns
{ buildJson, container }:

let
  app = buildJson.containers.app;
  # hickory-dns has no service-side Dockerfile / native_build.cmd → engine
  # skips the -binaries cache push (same as caddy/introspect-proxy). Only
  # ghcr.io/diegonmarcos/hickory-dns:latest exists on GHCR. Reference the
  # canonical image directly.
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}:latest";
in
{
  services = {
    hickory-dns = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      # #1898: critical path (mesh DNS 10.0.0.1): restart on crash/OOM kill, 64M ceiling, no swap.
      restart = "unless-stopped";
      memswap_limit = "64M";
      environment = {
        RUST_LOG = "hickory_dns=info,hickory_server=info";
      };
      volumes = [
        "./configs/named.toml:/etc/named.toml:ro"
        "./configs/zones:/etc/zones:ro"
      ];
      deploy.resources = {
        limits       = { memory = "64M"; cpus = "0.5"; };
        reservations = { memory = "16M"; };
      };
    };
  };
}
