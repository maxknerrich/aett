# The base system every aett machine gets. `fleet.json` sets the `aett` options.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.aett;
in
{
  options.aett = {
    name = lib.mkOption { type = lib.types.str; };
    role = lib.mkOption {
      type = lib.types.enum [
        "hypervisor"
        "server"
        "computer"
      ];
    };
    # Selects the nixpkgs input in flake.nix; recorded here so fleet.json passes through unchanged.
    channel = lib.mkOption {
      type = lib.types.enum [
        "stable"
        "unstable"
      ];
    };
    # nixpkgs attribute paths such as "htop" or "python3Packages.rich".
    packages = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
    operator.sshKeys = lib.mkOption { type = lib.types.listOf lib.types.str; };
  };

  config = {
    networking.hostName = cfg.name;
    networking.networkmanager.enable = true;
    # NetworkManager owns the interfaces; facter would otherwise start dhcpcd on them too.
    hardware.facter.detected.dhcp.enable = false;

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

    services.openssh = {
      enable = true;
      hostKeys = [
        {
          path = "/persist/etc/ssh/ssh_host_ed25519_key";
          type = "ed25519";
        }
      ];
      settings = {
        PermitRootLogin = "prohibit-password";
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
      };
    };

    # Root logs in with the operator's keys only; the locked password rules out console login.
    users.mutableUsers = false;
    users.users.root = {
      hashedPassword = "!";
      openssh.authorizedKeys.keys = cfg.operator.sshKeys;
    };

    environment.etc.machine-id.source = "/persist/etc/machine-id";

    services.logind.settings.Login = lib.mkIf (cfg.role != "computer") {
      HandleLidSwitch = "ignore";
      HandleLidSwitchExternalPower = "ignore";
      HandleLidSwitchDocked = "ignore";
    };

    environment.systemPackages = map (
      path: lib.getAttrFromPath (lib.splitString "." path) pkgs
    ) cfg.packages;

    boot.loader.systemd-boot.enable = true;
    boot.loader.efi.canTouchEfiVariables = true;

    nix.settings.experimental-features = [
      "nix-command"
      "flakes"
    ];

    system.stateVersion = "26.05";
  };
}
