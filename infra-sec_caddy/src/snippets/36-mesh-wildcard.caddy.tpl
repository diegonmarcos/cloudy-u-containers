  # #1797: the ONE publicly trusted certificate for every single-label mesh
  # name. Its only job is to put @MESH_WILDCARD@ under management (DNS-01 via
  # the global acme_dns cloudflare); Caddy then serves every
  # <name>.mesh.diegonmarcos.com vhost from it instead of a per-name leaf, so
  # service names stay out of Certificate Transparency logs. The specific
  # vhosts win routing over this block (exact host before wildcard), so it
  # only ever answers an undeclared mesh name: 403 off-mesh (same @not_mesh
  # gate as every mesh vhost), 404 on-mesh. It serves no upstream.
  @MESH_WILDCARD@ {
    # Bind must byte-match public routes: see 30-internal-route.caddy.tpl.
@PUBLIC_BIND_LINE@
@MESH_GUARD@
    tls {
      dns cloudflare {env.CF_API_TOKEN}
      resolvers 1.1.1.1 8.8.8.8
      propagation_delay 30s
      propagation_timeout 5m
    }
    header X-Edge-Fallback "1"
    header X-Edge-Route "mesh-wildcard"
    handle {
      error "Not Found" 404
    }
@HANDLE_ERRORS@
  }
