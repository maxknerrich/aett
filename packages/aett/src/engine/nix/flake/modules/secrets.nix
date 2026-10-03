# The secrets fleet.json lists for this machine, which sops-nix decrypts to /run/secrets/<name>. A
# plugin's module sets owner, mode and restarts on its own secrets.
{ config, lib, ... }:
{
  sops.secrets = lib.listToAttrs (
    map (secret: {
      inherit (secret) name;
      value = {
        sopsFile = ../. + "/${secret.file}";
        format = "binary";
      };
    }) config.aett.secrets
  );
}
