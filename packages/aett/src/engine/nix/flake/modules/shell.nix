# The shell set, a role default for servers and computers: the tools the fleet's dotfile sets expect.
# Hypervisors keep bash and nothing else.
{
  config,
  lib,
  pkgs,
  ...
}:
lib.mkIf (config.aett.role != "hypervisor") {
  programs.fish.enable = true;
  programs.mosh.enable = true;

  environment.systemPackages = [
    pkgs.starship
    pkgs.zoxide
    pkgs.bat
    pkgs.eza
    pkgs.toilet
  ];

  # The fleet pins every tool, so Claude Code's own updater stays off.
  environment.variables.DISABLE_AUTOUPDATER = "1";

  # Through a forward on a guest's host, mosh must answer at the address SSH reached, not at the guest's own.
  programs.fish.shellAliases.mosh = "mosh --experimental-remote-ip=remote";
}
