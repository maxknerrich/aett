# Tailscale, a role default: the machine enrolls itself with the fleet's auth key, advertising the tag of
# its role. sops-nix decrypts the key with the machine's SSH host key.
{ config, lib, ... }:
let
  cfg = config.aett.tailscale;
in
{
  options.aett.tailscale = lib.mkOption {
    type = lib.types.nullOr (
      lib.types.submodule {
        options = {
          tag = lib.mkOption { type = lib.types.str; };
          # Whether secrets/tailscale/auth-key.json is in the build. Without it the machine runs
          # Tailscale but can't enroll until the operator sets the key and applies again.
          authKey = lib.mkOption { type = lib.types.bool; };
        };
      }
    );
    default = null;
  };

  config = lib.mkIf (cfg != null) {
    services.tailscale = {
      enable = true;
      # Tailscale's own UDP port; SSH and mosh on the tailnet are open like on the LAN.
      openFirewall = true;
      authKeyFile = lib.mkIf cfg.authKey config.sops.secrets.tailscale-auth-key.path;
      extraUpFlags = [ "--advertise-tags=${cfg.tag}" ];
    };

    sops.secrets.tailscale-auth-key = lib.mkIf cfg.authKey {
      sopsFile = ../secrets/tailscale/auth-key.json;
      format = "binary";
    };
  };
}
