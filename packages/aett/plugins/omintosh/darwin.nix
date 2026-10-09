# omintosh: a keyboard-first Mac desktop. Rift tiles windows into five workspaces, SketchyBar shows them,
# JankyBorders outlines the focused window and Karabiner turns the Globe key into a modifier for it all.
# The configuration files land in the user's home from dotfiles/, where the fleet's own
# dotfiles/omintosh/<path> wins. macOS asks once to let Rift, SketchyBar and Karabiner control the Mac.
{ config, pkgs, ... }:
{
  homebrew = {
    taps = [ "acsandmann/tap" ];
    brews = [ "acsandmann/tap/rift" ];
    casks = [ "karabiner-elements" ];
  };

  # Rift runs ~/.config/rift/register.sh, which calls jq and sketchybar.
  launchd.user.agents.rift.serviceConfig = {
    ProgramArguments = [ "${config.homebrew.prefix}/bin/rift" ];
    EnvironmentVariables.PATH = "${config.environment.systemPath}:${config.homebrew.prefix}/bin";
    RunAtLoad = true;
    KeepAlive = true;
    ProcessType = "Interactive";
  };

  # Rift runs register.sh only when it starts, often before aett syncs the home; it restarts whenever
  # the sync places or changes its configuration.
  launchd.user.agents.rift-restart.serviceConfig = {
    ProgramArguments = [
      "/bin/sh"
      "-c"
      "/bin/launchctl kickstart -k gui/$(/usr/bin/id -u)/org.nixos.rift"
    ];
    WatchPaths = [ "/Users/${config.aett.user.name}/.config/rift" ];
  };

  environment.systemPackages = [ pkgs.jq ];

  # Reads ~/.config/sketchybar/sketchybarrc, which the dotfiles bring.
  services.sketchybar = {
    enable = true;
    extraPackages = [ pkgs.jq ];
  };

  # SketchyBar reads its configuration once, often before aett syncs the home; it reloads whenever the
  # sync places or changes it.
  launchd.user.agents.sketchybar-reload.serviceConfig = {
    ProgramArguments = [
      "${config.services.sketchybar.package}/bin/sketchybar"
      "--reload"
    ];
    WatchPaths = [ "/Users/${config.aett.user.name}/.config/sketchybar" ];
  };

  services.jankyborders = {
    enable = true;
    style = "round";
    width = 4.0;
    hidpi = true;
    active_color = "0xff58a6ff";
    inactive_color = "0x668b949e";
  };

  system.defaults = {
    NSGlobalDomain = {
      _HIHideMenuBar = true;
      "com.apple.keyboard.fnState" = false;
    };
    hitoolbox.AppleFnUsageType = "Do Nothing";
    dock.autohide = true;
  };
}
