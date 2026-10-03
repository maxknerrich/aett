# The fleet's user on a Mac is the account already there; aett doesn't create or remove it. It gets fish
# as its login shell.
{ config, lib, pkgs, ... }:
let
  cfg = config.aett.user;
in
lib.mkIf (cfg != null) {
  users.users.${cfg.name}.home = "/Users/${cfg.name}";

  environment.shells = [ pkgs.fish ];

  system.activationScripts.postActivation.text = ''
    if [ "$(/usr/bin/dscl . -read /Users/${cfg.name} UserShell | cut -d' ' -f2)" != /run/current-system/sw/bin/fish ]; then
      /usr/bin/dscl . -create /Users/${cfg.name} UserShell /run/current-system/sw/bin/fish
    fi
  '';
}
