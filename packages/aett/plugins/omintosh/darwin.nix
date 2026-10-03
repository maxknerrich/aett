# omintosh: a keyboard-first Mac desktop. Rift tiles windows into five workspaces, SketchyBar shows them,
# JankyBorders outlines the focused window and Karabiner turns the Globe key into a modifier for it all.
# The configuration files land in the user's home from home/, where the fleet's own
# home/omintosh/<path> wins. macOS asks once to let Rift, SketchyBar and Karabiner control the Mac.
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

  environment.systemPackages = [ pkgs.jq ];

  # Reads ~/.config/sketchybar/sketchybarrc, which the home tree brings.
  services.sketchybar = {
    enable = true;
    extraPackages = [ pkgs.jq ];
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
