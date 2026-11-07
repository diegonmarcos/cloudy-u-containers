# compose.nix — cloud-superapp-mcp (Type A own-code, single container)
#
# Pure Nix; _shared/engine.nix serialises this to YAML. Nothing about the
# constellation apps appears here: the app modules are a directory scan under
# code/mcps-apps/, and the route contract is code/lib-api/src/contract.ts.
# Adding an app is one folder, never a compose change.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  svc  = container.services;

  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  vmIp          = svc."cloud-superapp-mcp".ip;
  port          = toString buildJson.ports.app;
in
{
  services = {
    cloud-superapp-mcp = {
      image          = binariesImage;
      container_name = app.container_name;
      # host network, not published ports. The fleet runs dockerd with
      # iptables:false and userland-proxy:false (b_infra/_shared/vm-pilot/src/
      # modules/network/firewall.nix), so a published port has NO forwarding
      # mechanism: dockerd binds the socket -- the container even looks healthy
      # and logs the inbound initialize -- but the response never gets back.
      # Measured 2026-08-27, identical request to three endpoints:
      #   mail-mcp (host)         -> event: message {"result":...}
      #   cloud-drive-mcp (ports) -> nothing
      #   mattermost-mcp (ports)  -> nothing
      # Same conclusion cloud-mail-mcp already documents from 2026-08-25.
      network_mode   = "host";
      # Optional: ship logs "No secrets.yaml -- skipping" and never writes
      # .secrets when there is none. A required env_file makes compose abort
      # before it even pulls, which surfaces as "binaries:latest neither
      # pullable nor cached" -- the pull never ran. Same idiom as
      # user-comm_mail-puller. SUPERAPP_FLEET_TOKEN arrives through this file,
      # never through environment below.
      env_file       = [ { path = ".secrets"; required = false; } ];
      # The phone's AppDebugServer binds 127.0.0.1 on the device, so nothing
      # off-device can reach it: the only route in is `ssh phone` over the mesh
      # (see code/lib-mcp/src/device.ts). The ssh key is staged on the VM by the
      # ship engine from build.json's `ssh` block.
      volumes        = [ "/opt/ssh-keys/cloud-superapp-mcp:/root/.ssh:ro" ];
      environment = {
        PORT = port;
        # Bind the WG IP explicitly: under host network the listener would
        # otherwise sit on every host interface (it currently binds 0.0.0.0).
        # Same MCP_HTTP_HOST convention as the sibling host-mode MCPs.
        MCP_HTTP_HOST = vmIp;
        # Every alias here MUST be a build.json ssh.phones[].alias
        # (test/test-superapp-hosts.sh). Order = default dial order before any
        # phone has answered; afterwards the last phone that answered goes first.
        # Mesh only: no public route to a phone.
        SUPERAPP_PHONES = "samsung-a37,samsung-s21-plus";
      };
    };
  };
}
