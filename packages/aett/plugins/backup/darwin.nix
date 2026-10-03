# Backup with Kopia on a Mac: a client only. A launchd daemon backs up the user's home and the services'
# state hourly as root. macOS lets it read the home only once kopia has Full Disk Access, which the
# operator grants in System Settings.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  kopia = import ./kopia.nix { inherit config lib pkgs; };
in
lib.mkIf (!config.aett.services.backup.instance && kopia.ready) {
  launchd.daemons.aett-backup = {
    script = ''
      /bin/wait4path ${config.sops.secrets."backup/client/${config.aett.name}".path}
      exec ${kopia.client}
    '';
    serviceConfig = {
      StartInterval = 3600;
      RunAtLoad = true;
      ProcessType = "Background";
      StandardErrorPath = "/var/log/aett-backup.log";
      StandardOutPath = "/var/log/aett-backup.log";
    };
  };

  environment.systemPackages = [ (pkgs.writeShellScriptBin "aett-backup-health" kopia.clientHealth) ];
}
