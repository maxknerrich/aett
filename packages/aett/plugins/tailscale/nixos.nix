# Tailscale on a NixOS machine: aett's way to reach it. The machine joins once, when aett installs it or
# first applies it and the operator approves it; later boots keep its node.
{ config, lib, ... }:
{
  services.tailscale = {
    enable = true;
    # Tailscale's own UDP port; SSH and mosh on the tailnet are open like on the LAN.
    openFirewall = true;
  };

  # Started before the network is up, as a VM's is at boot, tailscaled never reaches a relay and stays
  # starting after its login. NixOS orders it after NetworkManager's wait already; a VM has networkd.
  systemd.services.tailscaled = lib.mkIf (!config.networking.networkmanager.enable) {
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
  };
}
