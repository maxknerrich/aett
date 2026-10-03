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
in
{
  # Whether the operator agreed to remove the apps fleet.ts doesn't list. aett asks once.
  options.aett.homebrew.zap = lib.mkOption {
    type = lib.types.bool;
    default = false;
  };

  config = {
    networking.hostName = cfg.name;
    networking.localHostName = cfg.name;

    system.primaryUser = cfg.user.name;

    # The Nix installer's daemon keeps running Nix and nix-darwin leaves it alone, so Determinate Nix
    # and an upstream install both work. Its nix.conf includes this file, where aett trusts the user
    # and llm-agents.nix's cache.
    nix.enable = false;
    environment.etc."nix/nix.custom.conf".text = ''
      experimental-features = nix-command flakes
      trusted-users = root ${cfg.user.name}
      extra-substituters = https://cache.numtide.com
      extra-trusted-public-keys = niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=
    '';

    # A Mac decrypts its secrets with the age key aett placed for it.
    sops.age.keyFile = "/var/lib/sops-nix/key.txt";
    sops.age.sshKeyPaths = [ ];

    homebrew = {
      enable = true;
      casks = cfg.apps;
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
