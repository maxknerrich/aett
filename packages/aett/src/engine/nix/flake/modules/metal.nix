# What a bare-metal machine adds to machine.nix: NetworkManager, mDNS, its boot loader and its identity on /persist.
{ config, lib, ... }:
{
  config = {
    networking.networkmanager.enable = true;
    # NetworkManager owns the interfaces; facter would otherwise start dhcpcd on them too.
    hardware.facter.detected.dhcp.enable = false;

    # The Wi-Fi the operator joined in the installer, which install copies over.
    aett.persist = [ "/etc/NetworkManager/system-connections" ];

    # Announces <name>.local.
    services.avahi = {
      enable = true;
      nssmdns4 = true;
      # Only IPv4 addresses, which the controller reaches on the LAN; a published IPv6 one can be unroutable.
      ipv6 = false;
      publish = {
        enable = true;
        addresses = true;
      };
    };

    # Install writes the key here from the fleet's secrets.
    services.openssh.hostKeys = [
      {
        path = "/persist/etc/ssh/ssh_host_ed25519_key";
        type = "ed25519";
      }
    ];

    environment.etc.machine-id.source = "/persist/etc/machine-id";

    services.logind.settings.Login = lib.mkIf (config.aett.role != "computer") {
      HandleLidSwitch = "ignore";
      HandleLidSwitchExternalPower = "ignore";
      HandleLidSwitchDocked = "ignore";
    };

    boot.loader.systemd-boot.enable = true;
    boot.loader.efi.canTouchEfiVariables = true;
  };
}
