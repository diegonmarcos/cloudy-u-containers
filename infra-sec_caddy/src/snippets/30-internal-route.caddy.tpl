  @SERVICE@ {
    # MUST match the public routes' bind LITERALLY (publicBindLine, i.e.
    # "bind 0.0.0.0 10.0.0.1"). `bind 10.0.0.1` alone put this site on its
    # own Caddy server (srv1, listen=[10.0.0.1:8443]) that caddy-l4's
    # forward target 127.0.0.1:8443 never reached — the whole .app/.db zone
    # was unreachable. Removing the bind entirely (first attempt, 6e3b65364)
    # was ALSO insufficient: Caddy's Caddyfile adapter groups servers by the
    # LITERAL listen string, and "no bind" (implicit ":8443") produced a
    # THIRD, still-different server (srv2) from the public routes' explicit
    # "0.0.0.0:8443" — even though both cover the same sockets. Only an
    # byte-identical bind directive guarantees one merged server. 2026-07-09.
@PUBLIC_BIND_LINE@
@MESH_GUARD@
@TLS_BLOCK@
    reverse_proxy @UPSTREAM@ {
@EMPTY_GUARD@
    }
@HANDLE_ERRORS@
  }
