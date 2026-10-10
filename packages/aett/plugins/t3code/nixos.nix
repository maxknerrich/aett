# T3 Code's server, which runs coding agents and serves the T3 Code app. It runs as the fleet's user,
# with the agents' logins and the projects in that user's home, on 127.0.0.1:3773, which aett's Caddy
# serves at https://<machine>.<tailnet>.ts.net:3773. `t3-pair` prints the link that pairs a device.
#
# The stable channel is T3 Code as llm-agents.nix pins it. The nightly channel is T3 Code's own build,
# which the service installs the first time and updates on every start, run through nix-ld.
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
  nightly = (cfg.services.t3code.options.channel or "stable") == "nightly";
  home = "/home/${user}";

  # The t3 the service runs: pinned, or the one T3 Code's installer keeps in ~/.local/bin.
  t3 = if nightly then "${home}/.local/bin/t3" else "${t3code}/bin/t3";

  # Installs T3 Code's nightly the first time and moves it to the newest nightly after that. Offline,
  # the installed one keeps serving.
  update = pkgs.writeShellScript "t3code-update" ''
    export T3CODE_CHANNEL=nightly
    if [ -x ${t3} ]; then
      ${t3} update --channel nightly --yes || echo "Could not update T3 Code; serving the installed one." >&2
    else
      curl -fsSL https://t3.codes/install.sh | sh
    fi
  '';

  # `t3 pair` links to the address the server listens on, which behind Caddy only this machine
  # reaches; this prints the link, and its QR code, for the endpoint instead.
  pair = pkgs.writeShellApplication {
    name = "t3-pair";
    runtimeInputs = [
      pkgs.gnused
      pkgs.qrencode
    ];
    text = ''
      link=$(${t3} pair "$@" | sed -n 's|^Pairing URL: [^#]*#|https://${cfg.tailnet.name}:${toString port}/pair#|p')
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
    # The agents and terminals it starts find what the user's login shell finds, and the agents T3 Code
    # drives, which llm-agents.nix pins either way.
    environment.PATH = lib.mkForce (
      lib.concatStringsSep ":" [
        (lib.makeBinPath (t3code.providerPackages ++ lib.optional nightly pkgs.curl))
        "/run/wrappers/bin"
        "/etc/profiles/per-user/${user}/bin"
        "/run/current-system/sw/bin"
      ]
    );
    serviceConfig = {
      User = user;
      WorkingDirectory = "~";
      ExecStartPre = lib.mkIf nightly update;
      ExecStart = "${t3} serve --host 127.0.0.1 --port ${toString port}";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  # T3 Code's own build is linked for other Linuxes; nix-ld gives it their loader.
  programs.nix-ld.enable = lib.mkIf nightly true;

  # The endpoint's address is known once the machine is on the tailnet.
  environment.systemPackages = [
    pkgs.git
  ]
  ++ lib.optional (!nightly) t3code
  ++ lib.optional (cfg.tailnet != null) pair;
}
