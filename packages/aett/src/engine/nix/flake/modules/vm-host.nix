# What a machine that runs VMs adds: microvm.nix's host, with guest state on /persist, and one bridge
# with NAT that every guest's tap joins. flake.nix lists the guests in microvm.vms.
{ config, lib, ... }:
let
  cfg = config.aett;
in
{
  options.aett = {
    guests = lib.mkOption { type = lib.types.listOf lib.types.str; };
    # Ports on the host that reach a guest with a home: its SSH, and its mosh range on the same ports.
    forwards = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            address = lib.mkOption { type = lib.types.str; };
            ssh = lib.mkOption { type = lib.types.port; };
            mosh.from = lib.mkOption { type = lib.types.port; };
            mosh.to = lib.mkOption { type = lib.types.port; };
          };
        }
      );
    };
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
      "d /nix/var/nix/gcroots/aett-guests/${guest} 0755 root root -"
      "L+ /nix/var/nix/gcroots/aett-guests/${guest}/current - - - - ${config.microvm.stateDir}/${guest}/current"
      "L+ /nix/var/nix/gcroots/aett-guests/${guest}/booted - - - - ${config.microvm.stateDir}/${guest}/booted"
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

    # Connections from the LAN to the host's own addresses on a forwarded port go to the guest; the
    # forward chain lets them through as DNAT. Over the tailnet a guest is reached as itself, under
    # its own ACL.
    networking.nftables.tables.aett-forwards = lib.mkIf (cfg.forwards != [ ]) {
      family = "ip";
      content = ''
        chain prerouting {
          type nat hook prerouting priority dstnat; policy accept;
          ${lib.concatMapStrings (forward: ''
            iifname != { "guests", "tailscale0" } fib daddr type local tcp dport ${toString forward.ssh} dnat to ${forward.address}:22
            iifname != { "guests", "tailscale0" } fib daddr type local udp dport ${toString forward.mosh.from}-${toString forward.mosh.to} dnat to ${forward.address}
          '') cfg.forwards}
        }
      '';
    };
  };
}
