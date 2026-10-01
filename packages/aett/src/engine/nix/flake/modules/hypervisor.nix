# A hypervisor is an appliance: root over SSH with the operator's keys, bash, and nothing else to log in to or run.
{ pkgs, ... }:
{
  security.sudo.enable = false;

  documentation.enable = false;
  environment.defaultPackages = [ ];

  # Nix serves aett's applies and nothing else.
  nix.channel.enable = false;
  nix.settings.allowed-users = [ "root" ];

  systemd.coredump.enable = false;
  boot.kernel.sysctl."kernel.core_pattern" = "|${pkgs.coreutils}/bin/false";

  programs.mosh.enable = true;
}
