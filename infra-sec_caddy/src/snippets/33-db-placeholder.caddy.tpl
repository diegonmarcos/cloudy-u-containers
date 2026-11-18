  @SERVICE@ {
    # Bind must byte-match public routes: see 30-internal-route.caddy.tpl.
    # 2026-07-09.
@PUBLIC_BIND_LINE@
@MESH_GUARD@
@TLS_BLOCK@
    respond "DB catalog — container=@CONTAINER@ engine=@ENGINE@ port=@PORT@ upstream=@UPSTREAM@ path=@DB_PATH@ vm=@VM@" 200
  }
