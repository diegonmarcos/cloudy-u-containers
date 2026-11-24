  (@RL_SNIPPET@) {
    rate_limit {
      zone @RL_ZONE@ {
        key    @RL_KEY@
        events @RL_EVENTS@
        window @RL_WINDOW@@RL_MATCH@
      }@RL_BACKSTOP@
    }
  }
