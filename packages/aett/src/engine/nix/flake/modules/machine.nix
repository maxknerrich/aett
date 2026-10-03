# The base system every aett NixOS machine gets, on metal or as a VM.
{ config, ... }:
let
  cfg = config.aett;
in
{
  networking.hostName = cfg.name;

  # Default deny; modules open what they serve.
  networking.nftables.enable = true;
  networking.firewall.enable = true;

  services.openssh = {
    enable = true;
    # aett makes the key and keeps it in the fleet's secrets. Install writes it to a metal machine's
    # disk; a guest's host shares it into the guest read-only.
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

  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  system.stateVersion = "26.05";
}
