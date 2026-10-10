# What a bare-metal machine adds to machine.nix: NetworkManager, mDNS, its boot loader and its identity on /persist.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # Firmware can pass over a new boot entry while a stale one of the same name remains, as Lenovo's
  # does: it keeps the old entry active and deactivates the new. So each boot loader install drops
  # systemd-boot's entries whose partition is gone, as after a reinstall, and activates this ESP's.
  bootEntries = pkgs.writeShellScript "aett-boot-entries" ''
    PATH=${
      lib.makeBinPath [
        pkgs.efibootmgr
        pkgs.util-linux
        pkgs.gnused
        pkgs.coreutils
      ]
    }
    esp=$(findmnt -no PARTUUID ${config.boot.loader.efi.efiSysMountPoint}) || exit 0
    efibootmgr | while IFS= read -r line; do
      case "$line" in
        Boot[0-9A-F][0-9A-F][0-9A-F][0-9A-F]*"Linux Boot Manager"*) ;;
        *) continue ;;
      esac
      uuid=$(printf '%s\n' "$line" | sed -n 's/.*HD([0-9]*,GPT,\([0-9a-f-]*\),.*/\1/p')
      if [ -z "$uuid" ]; then
        continue
      elif [ "$uuid" = "$esp" ]; then
        efibootmgr -q -b "''${line:4:4}" -a
      elif [ ! -e "/dev/disk/by-partuuid/$uuid" ]; then
        efibootmgr -q -b "''${line:4:4}" -B
      fi
    done
  '';
in
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

    environment.etc.machine-id.source = "/persist/etc/machine-id";

    services.logind.settings.Login = lib.mkIf (config.aett.role != "computer") {
      HandleLidSwitch = "ignore";
      HandleLidSwitchExternalPower = "ignore";
      HandleLidSwitchDocked = "ignore";
    };

    boot.loader.systemd-boot.enable = true;
    boot.loader.efi.canTouchEfiVariables = true;
    boot.loader.systemd-boot.extraInstallCommands = ''
      ${bootEntries} || echo "aett couldn't tidy the firmware's boot entries." >&2
    '';
  };
}
