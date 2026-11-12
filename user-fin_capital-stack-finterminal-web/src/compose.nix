# compose.nix — Capital-Stack-FinTerminal web (#1351): the static FinTerm pages (nginx, port 80 inside) published on the WG IP
# only, so the edge (Caddy, c3-pvt path /capital-stack-finterminal-web behind the shared gate) reaches it over WireGuard.
# No secret, no volume, read-only: the gate authenticates, the page reads /capital-stack-finterm-api same-origin.
{ buildJson, container, base_domain }:

let
  svc  = container.services;
  self = svc."capital-stack-finterminal-web";
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    capital-stack-finterminal-web = {
      image = binariesImage;
      container_name = buildJson.containers.app.container_name;
      ports = [ "${self.ip}:${toString buildJson.ports.app}:80" ];
      read_only = true;
      tmpfs = [ "/var/cache/nginx" "/var/run" "/tmp" ];
      deploy.resources = {
        limits = { cpus = "0.5"; memory = buildJson.resources.mem_limit; };
        reservations = { memory = buildJson.resources.mem_reservation; };
      };
    };
  };
}
