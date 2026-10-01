# The fleet's user, on a machine with a home: uid 1000, fish, wheel and the operators' SSH keys. sudo asks
# for the fleet-wide password, which sops-nix decrypts before users are made. Root stays locked.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.aett.user;
in
{
  options.aett.user = lib.mkOption {
    type = lib.types.nullOr (
      lib.types.submodule {
        options = {
          name = lib.mkOption { type = lib.types.str; };
          # Whether secrets/users/<name>.json is in the build; aett asks for it before the first build.
          password = lib.mkOption { type = lib.types.bool; };
        };
      }
    );
    default = null;
  };

  config = lib.mkIf (cfg != null) {
    users.users.${cfg.name} = {
      isNormalUser = true;
      uid = 1000;
      shell = pkgs.fish;
      extraGroups = [ "wheel" ];
      openssh.authorizedKeys.keys = config.aett.operator.sshKeys;
      hashedPasswordFile = lib.mkIf cfg.password config.sops.secrets.user-password.path;
    };

    sops.secrets.user-password = lib.mkIf cfg.password {
      sopsFile = ../secrets/users/${cfg.name}.json;
      format = "binary";
      neededForUsers = true;
    };

    aett.persist = [ "/home" ];

    # Activation makes the home directory before /home is mounted from /persist on a switch, so it is
    # made again on the persisted /home.
    systemd.tmpfiles.rules = [ "d /home/${cfg.name} 0700 ${cfg.name} users -" ];
  };
}
