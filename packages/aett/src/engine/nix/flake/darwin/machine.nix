# The base of a Mac aett manages: nix-darwin from the fleet's pins, applied on the Mac itself. Homebrew
# installs the apps fleet.ts lists and, once the operator agreed, removes the ones it doesn't. Touch ID
# answers sudo.
{
  config,
  lib,
  ...
}:
let
  cfg = config.aett;

  settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    trusted-users = [
      "root"
      cfg.user.name
    ];
    extra-substituters = [ "https://cache.numtide.com" ];
    extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
  };
in
{
  options.aett.homebrew = {
    # Whether the operator agreed to remove what Homebrew has that fleet.ts doesn't list. aett asks once.
    zap = lib.mkOption {
      type = lib.types.bool;
      default = false;
    };
    # The packages whose source is a Homebrew cask or formula.
    casks = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
    brews = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
  };

  config = {
    networking.hostName = cfg.name;
    networking.localHostName = cfg.name;

    system.primaryUser = cfg.user.name;

    # Determinate Nix keeps its daemon and reads aett's settings from nix.custom.conf; on an upstream
    # install nix-darwin runs Nix with them. Either way the user is trusted and llm-agents.nix's cache
    # is used.
    nix.enable = !cfg.darwin.determinate;
    nix.settings = lib.mkIf (!cfg.darwin.determinate) settings;
    environment.etc."nix/nix.custom.conf" = lib.mkIf cfg.darwin.determinate {
      text = lib.concatStrings (
        lib.mapAttrsToList (key: value: "${key} = ${lib.concatStringsSep " " value}\n") settings
      );
    };

    # A Mac decrypts its secrets with the age key aett placed for it.
    sops.age.keyFile = "/var/lib/sops-nix/key.txt";
    sops.age.sshKeyPaths = [ ];

    homebrew = {
      enable = true;
      inherit (cfg.homebrew) casks brews;
      # Apps come unpinned: apply installs what is missing, and aett update upgrades them.
      onActivation.cleanup = if config.aett.homebrew.zap then "zap" else "none";
    };

    security.pam.services.sudo_local = {
      touchIdAuth = true;
      reattach = true;
    };

    system.stateVersion = 6;
  };
}
