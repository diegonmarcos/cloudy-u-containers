# agent-credential.nix — which services in an agent project hold the push
# credential (#359). Pure builtins, no nixpkgs, so the tester can evaluate it.
#
# The engine used to hand the shared tree AND every sops key to EVERY service
# in a compose project. my-ai-api's project has two: the goose agent, and
# cloud-agi-bots (#542), a Telegram gateway that only makes HTTP calls. So the
# bots held GH_TOKEN three ways (env_file, /run/secrets/GH_TOKEN,
# /run/secrets.json) plus a writable tree and a push helper, for nothing.
# The token is a classic PAT with admin:org, delete_repo and admin:enterprise.
#
# build.json `agent.services` lists the compose services that ARE agents.
# Every other service in the project is withheld the tree and the credential.
# Unset = every service is an agent, which is the old behaviour, so no
# container that does not declare the field renders any differently.
{ agentSpec }:
let
  # Same name the engine's credential.helper reads and the containers' sops
  # files declare. cloud-infra 9_others/agent-credential-policy.json .env_var.
  var = "GH_TOKEN";
  # #359: the fine-grained replacement (contents:rw, workflows:rw, actions:r, metadata:r on the fleet
  # repos). The credential helper prefers it over `var`. The owner pastes it into each holder's
  # src/secrets.yaml (sops) as GH_FLEET_TOKEN, then deletes the GH_TOKEN key (#439) and the
  # classic PAT is revoked.
  fleetVar = "GH_FLEET_TOKEN";
  declared = agentSpec.services or null;
in
{
  inherit var fleetVar;

  isAgent = name: declared == null || builtins.elem name declared;

  # A misspelt name would make NO service an agent and silently take the tree
  # away from the real one. Fail the build instead.
  checkNames = names:
    let bad = if declared == null then []
              else builtins.filter (n: !(builtins.elem n names)) declared;
    in if bad == []
       then null
       else throw ("agent.services names ${builtins.toJSON bad}, which the "
                   + "compose project does not have (services: "
                   + builtins.toJSON names + ")");

  # For a non-agent service that still loads the project's .secrets env_file:
  # compose gives `environment` precedence over `env_file`, so this blanks the
  # token while the service keeps the keys it does need (TELEGRAM_BOT_TOKEN...).
  withhold = svc:
    let e = svc.environment or {}; in
    svc // {
      environment = if builtins.isAttrs e
                    then e // { ${var} = ""; }
                    else e ++ [ "${var}=" ];
    };
}
