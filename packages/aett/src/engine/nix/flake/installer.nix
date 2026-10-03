# The aett installer image: a minimal NixOS live system that `aett machine install` drives over SSH.
{
  lib,
  pkgs,
  revision,
  ...
}:
{
  networking.hostName = "aett-installer";

  # Each boot sets a fresh random root password and shows it on the console.
  # Letters only, without g, i, l, o and q: digits and those letters have lookalikes on the console.
  systemd.services.aett-installer-code = {
    description = "Generate the aett installer code";
    wantedBy = [ "multi-user.target" ];
    before = [
      "systemd-user-sessions.service"
      "sshd.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    path = [
      pkgs.coreutils
      pkgs.shadow
    ];
    script = ''
      alphabet=abcdefhjkmnprstuvwxyz
      code=
      # Rejection sampling: 252 is the largest multiple of 21 below 256, so every character is equally likely.
      for byte in $(od -An -N64 -tu1 /dev/urandom); do
        if (( byte < 252 )); then
          code+=''${alphabet:byte % 21:1}
          (( ''${#code} == 8 )) && break
        fi
      done
      (( ''${#code} == 8 ))
      echo "root:$code" | chpasswd
      mkdir -p /run/issue.d
      printf '\n  aett installer ${revision}, code: \e[1m%s\e[0m\n\n' "$code" > /run/issue.d/aett.issue
    '';
  };

  # Replaces the stock text, which says root has an empty password.
  services.getty.helpLine = lib.mkForce ''
    Join Wi-Fi with `nmtui`, then run `aett machine install <name>` on the controller.
    `aett-code` shows the code again.
  '';

  services.openssh.settings = {
    PermitRootLogin = "yes";
    PasswordAuthentication = true;
  };

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

  environment.systemPackages = [
    pkgs.nixos-facter
    (pkgs.writeShellScriptBin "aett-code" "cat /run/issue.d/aett.issue")
  ];

  # aett installs btrfs; leaving out ZFS keeps the image smaller.
  boot.supportedFilesystems.zfs = lib.mkForce false;

  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  image.baseName = lib.mkForce "aett-installer-${pkgs.stdenv.hostPlatform.system}";

  system.stateVersion = "26.05";
}
