# Unlocking an encrypted machine over its LAN. Its initrd brings up Ethernet or the Wi-Fi networks the
# machine knows and runs sshd on port 2222, with the key install made in /persist/aett/unlock. The
# operators' keys there can only answer the disk's passphrase prompt: aett machine unlock pipes the
# passphrase to aett-unlock. From another network, the operator reaches the LAN first, such as over a VPN.
#
# Everything here sits unencrypted on the ESP: the SSH host key and the Wi-Fi passwords.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  directory = "/persist/aett/unlock";
  initrd = config.boot.initrd.systemd;

  # Answers every passphrase prompt for a LUKS device with the line on stdin until all are open.
  unlock = pkgs.writeShellScript "aett-unlock" ''
    PATH=${lib.makeBinPath [ pkgs.coreutils pkgs.gnused ]}
    IFS= read -r passphrase || exit 1
    for _ in $(seq 120); do
      open=true
      for name in ${lib.escapeShellArgs (builtins.attrNames config.boot.initrd.luks.devices)}; do
        [ -b "/dev/mapper/$name" ] || open=false
      done
      if $open; then
        echo "Unlocked. ${config.aett.name} boots now."
        exit 0
      fi
      for request in /run/systemd/ask-password/ask.*; do
        [ -f "$request" ] || continue
        socket=$(sed -n 's/^Socket=//p' "$request")
        case "$(sed -n 's/^Id=//p' "$request")" in
          cryptsetup:*) [ -S "$socket" ] && printf '%s\n' "$passphrase" | /bin/systemd-reply-password 1 "$socket" ;;
        esac
      done
      sleep 1
    done
    echo "The disks didn't open. Is the passphrase right?" >&2
    exit 1
  '';

  # Runs wpa_supplicant on the first wireless interface that appears.
  wifi = pkgs.writeShellScript "aett-unlock-wifi" ''
    PATH=${lib.makeBinPath [ pkgs.coreutils ]}
    for _ in $(seq 60); do
      for device in /sys/class/net/*; do
        if [ -d "$device/wireless" ]; then
          exec ${pkgs.wpa_supplicant}/bin/wpa_supplicant -Dnl80211 -i "''${device##*/}" -c /etc/aett/wpa_supplicant.conf
        fi
      done
      sleep 1
    done
    echo "No wireless interface appeared." >&2
  '';

  # Starts in the initrd and stops before it hands over to the system.
  early = {
    unitConfig.DefaultDependencies = false;
    before = [
      "shutdown.target"
      "initrd-switch-root.target"
    ];
    conflicts = [
      "shutdown.target"
      "initrd-switch-root.target"
    ];
    wantedBy = [ "initrd.target" ];
  };
in
{
  options.aett.unlock = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Whether install made the initrd's sshd key in ${directory}.";
  };

  config = lib.mkIf config.aett.unlock {
    boot.initrd.network.enable = true;
    boot.initrd.systemd.network = {
      enable = true;
      wait-online.anyInterface = true;
      networks."20-aett-unlock" = {
        matchConfig.Type = [
          "ether"
          "wlan"
        ];
        networkConfig.DHCP = "yes";
        # As NetworkManager asks, so the DHCP server hands out the address aett recorded.
        dhcpV4Config.ClientIdentifier = "mac";
      };
    };

    boot.initrd.availableKernelModules = [
      # Intel Wi-Fi's operation modes, which iwlwifi loads once it knows the card.
      "iwlmvm"
      "iwldvm"
    ];

    boot.initrd.secrets."/etc/aett/wpa_supplicant.conf" = "${directory}/wpa_supplicant.conf";

    boot.initrd.systemd.extraBin = {
      aett-unlock = unlock;
      systemd-reply-password = "${initrd.package}/lib/systemd/systemd-reply-password";
    };

    boot.initrd.systemd.services.aett-unlock-wifi = early // {
      after = [ "initrd-nixos-copy-secrets.service" ];
      requires = [ "initrd-nixos-copy-secrets.service" ];
      serviceConfig = {
        ExecStart = wifi;
        Restart = "on-failure";
      };
    };

    boot.initrd.network.ssh = {
      enable = true;
      # Not the system's port, so ssh clients that know the machine by its address don't see two host keys there.
      port = 2222;
      hostKeys = [ "${directory}/ssh_host_ed25519_key" ];
      # The operators can only answer the passphrase prompt.
      authorizedKeys = map (key: ''restrict,command="/bin/aett-unlock" ${key}'') config.aett.operator.sshKeys;
    };
  };
}
