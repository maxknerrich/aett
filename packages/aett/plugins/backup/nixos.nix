# Backup with Kopia on NixOS. The instance is the repository server: it keeps the repository on its bulk
# state, made with a generated password, and serves it over TLS with a certificate whose fingerprint
# every client pins, one Kopia user per client. Every other machine with a home or service state backs
# them up to it hourly. Restoring is manual: kopia is on every machine.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.aett;
  service = cfg.services.backup;
  kopia = import ./kopia.nix { inherit config lib pkgs; };
  bin = "${cfg.pkgs.kopia}/bin/kopia";
  clients = lib.filter (peer: !peer.instance) service.peers;
  directory = "/var/lib/aett-backup";
  secret = name: config.sops.secrets."backup/${name}".path;

  # Opens the repository, making it the first time, sets the policy every client starts from and adds
  # a Kopia user per client, dropping those that left.
  prepare = pkgs.writeShellScript "aett-backup-prepare" ''
    set -eu
    export KOPIA_PASSWORD="$(cat ${secret "repository/${cfg.name}"})"
    export KOPIA_CHECK_FOR_UPDATES=false
    ks() { ${bin} --config-file=${directory}/server.config --no-persist-credentials "$@"; }

    if [ -f ${directory}/repository/kopia.repository.f ]; then
      ks repository connect filesystem --path=${directory}/repository --cache-directory=/var/cache/aett-backup \
        --override-username=aett --override-hostname=${cfg.name}
    else
      mkdir -p ${directory}/repository
      ks repository create filesystem --path=${directory}/repository --cache-directory=/var/cache/aett-backup \
        --override-username=aett --override-hostname=${cfg.name}
    fi

    ks policy set --global --compression=zstd --add-dot-ignore=.kopiaignore \
      ${lib.concatMapStringsSep " " (pattern: "--add-ignore=${lib.escapeShellArg pattern}") kopia.ignored}

    ${lib.concatMapStrings (client: ''
      password="$(cat ${secret "client/${client.name}"})"
      if ks server users info aett@${client.name} >/dev/null 2>&1; then
        ks server users set aett@${client.name} --user-password="$password"
      else
        ks server users add aett@${client.name} --user-password="$password"
      fi
    '') clients}

    for user in $(ks server users list --json | ${pkgs.jq}/bin/jq -r '.[].username'); do
      case " ${lib.concatMapStringsSep " " (client: "aett@${client.name}") clients} " in
        *" $user "*) ;;
        *) ks server users delete "$user" ;;
      esac
    done
  '';

  # Serves the repository; the password opens it, since neither prepare nor this keeps it on disk.
  start = pkgs.writeShellScript "aett-backup-server" ''
    export KOPIA_PASSWORD="$(cat ${secret "repository/${cfg.name}"})"
    exec ${bin} --config-file=${directory}/server.config --no-persist-credentials server start \
      --address=0.0.0.0:${toString kopia.port} \
      --tls-cert-file=${secret "tls/${cfg.name}"} --tls-key-file=${secret "tls/${cfg.name}"} \
      --no-ui --no-control-api --grpc
  '';

  server = lib.mkIf service.instance {
    systemd.services.aett-backup-server = {
      description = "Kopia repository server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      unitConfig.RequiresMountsFor = [ directory ];
      environment.KOPIA_CHECK_FOR_UPDATES = "false";
      serviceConfig = {
        ExecStartPre = prepare;
        ExecStart = start;
        Restart = "on-failure";
        RestartSec = 10;
        UMask = "0077";
        CacheDirectory = "aett-backup";
      };
      restartTriggers = [ (builtins.toJSON (map (client: client.name) clients)) ];
    };

    sops.secrets = lib.listToAttrs (
      map (client: {
        name = "backup/client/${client.name}";
        value.restartUnits = [ "aett-backup-server.service" ];
      }) clients
    );

    environment.systemPackages = [
      (pkgs.writeShellScriptBin "aett-backup-health" ''
        systemctl is-active --quiet aett-backup-server.service || { echo "server not running"; exit 1; }
        echo "serves ${toString (builtins.length clients)} clients"
      '')
    ];
  };

  client = lib.mkIf (!service.instance && kopia.ready) {
    systemd.services.aett-backup = {
      description = "Back up the home and the services' state with Kopia";
      after = [
        "network-online.target"
        "tailscaled.service"
      ];
      wants = [ "network-online.target" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = kopia.client;
        Nice = 10;
        IOSchedulingClass = "idle";
      };
    };

    systemd.timers.aett-backup = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "hourly";
        Persistent = true;
        RandomizedDelaySec = "10min";
      };
    };

    environment.systemPackages = [ (pkgs.writeShellScriptBin "aett-backup-health" kopia.clientHealth) ];
  };
in
lib.mkMerge [
  server
  client
]
