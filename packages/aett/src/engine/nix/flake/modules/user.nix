# The fleet's user, on every machine but a hypervisor: uid 1000, fish, wheel and the operators' SSH keys.
# sudo asks for the fleet-wide password, which sops-nix decrypts before users are made. Root stays locked.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.aett.user;
  secret = "users/${cfg.name}";
in
lib.mkIf (cfg != null) {
  users.users.${cfg.name} = {
    isNormalUser = true;
    uid = 1000;
    shell = pkgs.fish;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = config.aett.operator.sshKeys;
    hashedPasswordFile = lib.mkIf cfg.password config.sops.secrets.${secret}.path;
  };

  sops.secrets.${secret}.neededForUsers = lib.mkIf cfg.password true;

  aett.persist = [ "/home" ];

  # Activation makes the home directory before /home is mounted from /persist on a switch, so it is
  # made again on the persisted /home.
  systemd.tmpfiles.rules = [ "d /home/${cfg.name} 0700 ${cfg.name} users -" ];
}
