# CLIProxyAPI, which serves the coding agents' subscriptions as OpenAI-, Claude- and Gemini-compatible
# APIs. It runs as the fleet's user, keeps the logins in ~/.cli-proxy-api and listens on
# 127.0.0.1:8317, which aett's Caddy serves at https://<machine>.<tailnet>.ts.net:8317. Clients need
# no key: the tailnet decides who reaches it. `cli-proxy-api --codex-device-login` and the like log in,
# as does its web panel at /management.html, which takes the password aett asked for.
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
    oauth.auth-dir = "~/.cli-proxy-api";
  };

  # CLIProxyAPI reading this configuration, for the service and for logging in.
  cli = pkgs.writeShellScriptBin "cli-proxy-api" ''
    exec ${cfg.pkgs.cli-proxy-api}/bin/cli-proxy-api --config ${settings} "$@"
  '';

  # The panel's password, which turns on the management API the panel drives.
  start = pkgs.writeShellScript "cli-proxy-api-start" ''
    MANAGEMENT_PASSWORD="$(cat "$CREDENTIALS_DIRECTORY/panel")"
    export MANAGEMENT_PASSWORD
    exec ${cli}/bin/cli-proxy-api
  '';
in
{
  systemd.services.cli-proxy-api = {
    description = "CLIProxyAPI";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    # The panel is a page CLIProxyAPI downloads and keeps up to date.
    environment.MANAGEMENT_STATIC_PATH = "/var/cache/cli-proxy-api";
    serviceConfig = {
      User = cfg.user.name;
      WorkingDirectory = "~";
      CacheDirectory = "cli-proxy-api";
      LoadCredential = "panel:${config.sops.secrets."cli-proxy/panel".path}";
      ExecStart = start;
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  sops.secrets."cli-proxy/panel".restartUnits = [ "cli-proxy-api.service" ];

  environment.systemPackages = [ cli ];
}
