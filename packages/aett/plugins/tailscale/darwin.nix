# Tailscale on a Mac. One already on the tailnet through the Tailscale app keeps it and its node, as
# aett found it. Otherwise tailscaled runs as a launchd daemon and the Mac joins once with the one-time
# key aett minted for it.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.aett;
  key = "${cfg.name}/tailscale-key";
  minted = lib.any (secret: secret.name == key) cfg.secrets;
in
lib.mkIf (!cfg.tailscale.app) {
  services.tailscale.enable = true;

  # nix-darwin's module runs the daemon but doesn't join; this does, once, while the Mac isn't logged in.
  launchd.daemons.aett-tailscale-up = lib.mkIf minted {
    script = ''
      /bin/wait4path ${config.sops.secrets.${key}.path}
      for _ in $(seq 60); do
        state=$(${pkgs.tailscale}/bin/tailscale status --json 2>/dev/null | ${pkgs.jq}/bin/jq -r .BackendState)
        case "$state" in
          Running) exit 0 ;;
          NeedsLogin|NeedsMachineAuth|Stopped)
            exec ${pkgs.tailscale}/bin/tailscale up --auth-key=file:${config.sops.secrets.${key}.path} --advertise-tags=${cfg.tailscale.tag} ;;
        esac
        sleep 2
      done
      exit 1
    '';
    serviceConfig = {
      RunAtLoad = true;
      KeepAlive = false;
    };
  };
}
