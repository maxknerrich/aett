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

    # The runner a guest boots next and the one it runs keep their closures, whichever system linked
    # them; aett's apply links a guest's runner without switching the host.
    systemd.tmpfiles.rules = lib.concatMap (guest: [
      "L+ /nix/var/nix/gcroots/aett-guests/${guest} - - - - ${config.microvm.stateDir}/${guest}/current"
      "L+ /nix/var/nix/gcroots/aett-guests/booted-${guest} - - - - ${config.microvm.stateDir}/${guest}/booted"
    ]) cfg.guests;

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

    # Forwarding carries what guests start, which the NAT module allows. Nothing reaches a guest
    # through the host otherwise, not even from a LAN machine that routes 10.100.0.0/16 here.
    networking.firewall.filterForward = true;
  };
}
