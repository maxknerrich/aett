# `aett machine install` runs this script on the installer once disko has mounted the new system at $1.
{
  config,
  lib,
  pkgs,
  ...
}:
{
  system.build.aettInstall = pkgs.writeShellScript "aett-install" ''
    set -euo pipefail
    root=$1

    for dir in ${lib.escapeShellArgs config.aett.persist}; do
      mkdir -p "$root/persist$dir"
    done

    ${pkgs.systemd}/bin/systemd-machine-id-setup --root="$root/persist"

    # The Wi-Fi the operator joined in the installer; its password never enters the fleet repository.
    if [ -d /etc/NetworkManager/system-connections ]; then
      cp -a /etc/NetworkManager/system-connections/. "$root/persist/etc/NetworkManager/system-connections/"
    fi
  '';
}
