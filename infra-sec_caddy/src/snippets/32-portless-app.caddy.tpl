  @SERVICE@ {
    # Bind must byte-match public routes: see 30-internal-route.caddy.tpl.
    # 2026-07-09.
@PUBLIC_BIND_LINE@
@MESH_GUARD@
@TLS_BLOCK@
    respond "@PLACEHOLDER_MSG@" 204
  }
