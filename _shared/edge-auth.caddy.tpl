  (@GATE@) {
    @ea_pre {
      method OPTIONS
      header Access-Control-Request-Method *
    }
    @ea_fleet {
      header X-Fleet-Authorization Bearer*
      not path {args[:]}
      not {
        method OPTIONS
        header Access-Control-Request-Method *
      }@EA_EXTRA@@EA_OFFMESH@
    }
    @ea_bearer {
      header Authorization Bearer*
      not header X-Fleet-Authorization Bearer*
@EA_PASS@      not path {args[:]}
      not {
        method OPTIONS
        header Access-Control-Request-Method *
      }@EA_EXTRA@@EA_OFFMESH@
    }
    @ea_session {
      not header Authorization Bearer*
      not header X-Fleet-Authorization Bearer*
@EA_SSO_NOT@@EA_RL_SESSION_NOT@      not path {args[:]}
      not {
        method OPTIONS
        header Access-Control-Request-Method *
      }@EA_EXTRA@@EA_OFFMESH@
    }
    respond @ea_pre 204
    # Dedicated fleet-token header for clients whose Authorization carries another
    # credential (Stalwart Basic/Bearer on jmap./mails.). Wins over Authorization.
    forward_auth @ea_fleet @INTROSPECT_UPSTREAM@ {
      # A websocket upgrade must not reach the auth subrequest: an introspect/authelia
      # backend that gets Connection: Upgrade never answers and the edge hangs.
      header_up -Connection
      header_up -Upgrade
      method GET
      uri @INTROSPECT_URI@
      header_up Authorization {http.request.header.X-Fleet-Authorization}
      copy_headers @INTROSPECT_COPY@@EA_DENY@
    }
    # Never forward the fleet token to an upstream; Authorization passes untouched.
    request_header -X-Fleet-Authorization
    forward_auth @ea_bearer @INTROSPECT_UPSTREAM@ {
      # A websocket upgrade must not reach the auth subrequest: an introspect/authelia
      # backend that gets Connection: Upgrade never answers and the edge hangs.
      header_up -Connection
      header_up -Upgrade
      method GET
      uri @INTROSPECT_URI@
      copy_headers @INTROSPECT_COPY@@EA_DENY@
    }
    forward_auth @ea_session @AUTHELIA_UPSTREAM@ {
      # A websocket upgrade must not reach the auth subrequest: an introspect/authelia
      # backend that gets Connection: Upgrade never answers and the edge hangs.
      header_up -Connection
      header_up -Upgrade
      uri @AUTHELIA_URI@
      header_up X-Forwarded-Uri {http.request.orig_uri}
      copy_headers @AUTHELIA_COPY@
    }@EA_SSO_BLOCK@@EA_RL@
  }
