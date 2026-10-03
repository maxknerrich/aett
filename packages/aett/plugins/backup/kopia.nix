# What the backup plugin's NixOS and nix-darwin modules share: the client's backup script, the ignore
# list every client starts from, and where Kopia keeps things.
{
  config,
  lib,
  pkgs,
}:
let
  cfg = config.aett;
  service = cfg.services.backup;
  kopia = "${cfg.pkgs.kopia}/bin/kopia";
  server = lib.findFirst (peer: peer.instance) null service.peers;
  home = if pkgs.stdenv.isDarwin then "/Users" else "/home";
in
rec {
  port = 51515;

  # Directories every client leaves out, besides what .kopiaignore files name: caches and things a
  # package manager or a build brings back.
  ignored = [
    ".cache/"
    "Library/Caches/"
    ".Trash/"
    ".local/share/Trash/"
    "node_modules/"
    ".npm/_cacache/"
    ".pnpm-store/"
    ".cargo/registry/"
    ".rustup/"
    "go/pkg/mod/"
    ".direnv/"
    ".venv/"
    "__pycache__/"
    ".DS_Store"
  ];

  # The client's Kopia state: its connection to the server and its cache.
  clientDirectory = "/var/lib/aett-backup-client";

  # Whether this machine can back up yet: the server is on the tailnet and its certificate exists.
  ready = server != null && server.tailnet != null && server.fingerprints ? tls;

  # The home and the state this machine keeps.
  sources = lib.optional (cfg.user != null) "${home}/${cfg.user.name}" ++ map (dir: dir.path) cfg.state;

  # Connects once, as aett@<machine>, then snapshots every source. Kopia keeps the snapshots the
  # server's global policy says. It reaches the server by its tailnet address, which needs no
  # MagicDNS; the pinned fingerprint, not the name, proves it is the server.
  client = pkgs.writeShellScript "aett-backup" ''
    set -eu
    export KOPIA_PASSWORD="$(cat ${config.sops.secrets."backup/client/${cfg.name}".path})"
    export KOPIA_CHECK_FOR_UPDATES=false
    kc() { ${kopia} --config-file=${clientDirectory}/repository.config --no-persist-credentials "$@"; }

    # Connects again when the server moved or has a new certificate.
    server="https://${server.tailnet.address}:${toString port} ${server.fingerprints.tls}"
    if [ ! -f ${clientDirectory}/repository.config ] || [ "$(cat ${clientDirectory}/server 2>/dev/null)" != "$server" ]; then
      mkdir -p ${clientDirectory}
      kc repository disconnect 2>/dev/null || rm -f ${clientDirectory}/repository.config
      kc repository connect server \
        --url=https://${server.tailnet.address}:${toString port} \
        --server-cert-fingerprint=${server.fingerprints.tls} \
        --override-username=aett --override-hostname=${cfg.name} \
        --cache-directory=${clientDirectory}/cache
      printf '%s' "$server" > ${clientDirectory}/server
    fi

    ${lib.concatMapStrings (source: ''
      if [ -e ${lib.escapeShellArg source} ]; then kc snapshot create ${lib.escapeShellArg source}; fi
    '') sources}
    date -u +%Y-%m-%dT%H:%M:%SZ > ${clientDirectory}/last-success
  '';

  # How the client is: when it last backed up. Unhealthy without a backup in the last two hours.
  clientHealth = ''
    last=$(cat ${clientDirectory}/last-success 2>/dev/null) || { echo "no backup yet"; exit 1; }
    echo "backed up $last"
    [ $(( $(date -u +%s) - $(date -u -d "$last" +%s 2>/dev/null || date -u -j -f %Y-%m-%dT%H:%M:%SZ "$last" +%s) )) -lt 7200 ]
  '';
}
