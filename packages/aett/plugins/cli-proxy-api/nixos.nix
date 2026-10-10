# CLIProxyAPI, which serves the coding agents' subscriptions as OpenAI-, Claude- and Gemini-compatible
# APIs. It runs as the fleet's user, keeps the logins in ~/.cli-proxy-api and listens on
# 127.0.0.1:8317, which aett's Caddy serves at https://<machine>.<tailnet>.ts.net:8317. Clients need
# no key: the tailnet decides who reaches it. `cli-proxy-api --codex-device-login` and the like log in.
{
  config,
  pkgs,
  ...
}:
let
  cfg = config.aett;

  settings = (pkgs.formats.yaml { }).generate "cli-proxy-api.yaml" {
    config-version = 8;
    server = {
      host = "127.0.0.1";
      port = 8317;
    };
    access.api-keys = [ ];
    # No management API, and so no control panel to download.
    management = {
      secret-key = "";
      disable-control-panel = true;
    };
    oauth.auth-dir = "~/.cli-proxy-api";
  };

  # CLIProxyAPI reading this configuration, for the service and for logging in.
  cli = pkgs.writeShellScriptBin "cli-proxy-api" ''
    exec ${cfg.pkgs.cli-proxy-api}/bin/cli-proxy-api --config ${settings} "$@"
  '';
in
{
  systemd.services.cli-proxy-api = {
    description = "CLIProxyAPI";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      User = cfg.user.name;
      WorkingDirectory = "~";
      ExecStart = "${cli}/bin/cli-proxy-api";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  environment.systemPackages = [ cli ];
}
