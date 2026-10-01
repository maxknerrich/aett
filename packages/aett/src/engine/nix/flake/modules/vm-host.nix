# What a machine that runs VMs adds: microvm.nix's host, with guest state on /persist, and one bridge
# with NAT that every guest's tap joins. flake.nix lists the guests in microvm.vms.
{ config, lib, ... }:
let
  cfg = config.aett;
in
{
  options.aett = {
    guests = lib.mkOption { type = lib.types.listOf lib.types.str; };
    network = {
      address = lib.mkOption { type = lib.types.str; };
      prefixLength = lib.mkOption { type = lib.types.int; };
    };
  };

  config = {
    # Each guest's runner links, state volume and identity share live in <stateDir>/<name>.
    microvm.stateDir = "/persist/microvms";
    microvm.host.installCommand = false;

    # networkd runs the bridge and the guests' taps; NetworkManager keeps the uplink and leaves them alone.
    networking.networkmanager.unmanaged = [
      "interface-name:guests"
      "interface-name:vm-*"
    ];
    systemd.network = {
      enable = true;
      # NetworkManager decides when the machine is online.
      wait-online.enable = false;
      netdevs."10-guests".netdevConfig = {
        Name = "guests";
        Kind = "bridge";
      };
      networks."10-guests" = {
        matchConfig.Name = "guests";
        address = [ "${cfg.network.address}/${toString cfg.network.prefixLength}" ];
        networkConfig = {
          ConfigureWithoutCarrier = true;
          LinkLocalAddressing = "no";
        };
        linkConfig.RequiredForOnline = "no";
      };
      networks."11-guest-taps" = {
        matchConfig.Name = "vm-*";
        networkConfig = {
          Bridge = "guests";
          LinkLocalAddressing = "no";
        };
        linkConfig.RequiredForOnline = "no";
      };
    };

    # Guests reach the internet through whichever uplink the host has.
    networking.nat = {
      enable = true;
      internalInterfaces = [ "guests" ];
    };
  };
}
