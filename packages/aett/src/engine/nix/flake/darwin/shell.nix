# The shell set on a Mac, as on every NixOS server and computer: the tools the fleet's dotfiles expect.
{ pkgs, ... }:
{
  programs.fish.enable = true;

  environment.systemPackages = [
    pkgs.starship
    pkgs.zoxide
    pkgs.bat
    pkgs.eza
    pkgs.mosh
    pkgs.toilet
  ];

  # The fleet pins every tool, so Claude Code's own updater stays off.
  environment.variables.DISABLE_AUTOUPDATER = "1";
}
