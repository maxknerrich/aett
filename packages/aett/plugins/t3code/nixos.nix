# T3 Code's server, which runs coding agents and serves the T3 Code app. It runs as the fleet's user,
# with the agents' logins and the projects in that user's home, on 127.0.0.1:3773, which aett's Caddy
# serves at https://<machine>.<tailnet>.ts.net:3773. `t3-pair` prints the link that pairs a device.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.aett;
  user = cfg.user.name;
  t3code = cfg.pkgs.t3code;
  port = 3773;

  # `t3 pair` links to the address the server listens on, which behind Caddy only this machine
  # reaches; this prints the link, and its QR code, for the endpoint instead.
  pair = pkgs.writeShellApplication {
    name = "t3-pair";
    runtimeInputs = [
      t3code
      pkgs.gnused
      pkgs.qrencode
    ];
    text = ''
      link=$(t3 pair "$@" | sed -n 's|^Pairing URL: [^#]*#|https://${cfg.tailnet.name}:${toString port}/pair#|p')
      if [ -z "$link" ]; then
        echo "t3 pair printed no pairing link." >&2
        exit 1
      fi
      qrencode -t ANSIUTF8 "$link"
      echo "Pairing URL: $link"
    '';
  };
in
{
  systemd.services.t3code = {
    description = "T3 Code server";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    # The agents and terminals it starts find what the user's login shell finds.
    environment.PATH = lib.mkForce "/run/wrappers/bin:/etc/profiles/per-user/${user}/bin:/run/current-system/sw/bin";
    serviceConfig = {
      User = user;
      WorkingDirectory = "~";
      ExecStart = "${t3code}/bin/t3 serve --host 127.0.0.1 --port ${toString port}";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  # The endpoint's address is known once the machine is on the tailnet.
  environment.systemPackages = [
    t3code
    pkgs.git
  ]
  ++ lib.optional (cfg.tailnet != null) pair;
}
