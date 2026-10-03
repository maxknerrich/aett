# Tailscale on a NixOS machine: aett's way to reach it. The machine joins once with the one-time key aett
# minted for it, advertising the tag of its role; later boots keep its node.
{ config, lib, ... }:
let
  key = "${config.aett.name}/tailscale-key";
  minted = lib.any (secret: secret.name == key) config.aett.secrets;
in
{
  services.tailscale = {
    enable = true;
    # Tailscale's own UDP port; SSH and mosh on the tailnet are open like on the LAN.
    openFirewall = true;
    authKeyFile = lib.mkIf minted config.sops.secrets.${key}.path;
    extraUpFlags = [ "--advertise-tags=${config.aett.tailscale.tag}" ];
  };
}
