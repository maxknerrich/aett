# Where the plugins' state lives: on a NAS, bulk state on the tank pool; everything else on /persist,
# like /var/lib already is.
{
  config,
  lib,
  utils,
  ...
}:
let
  cfg = config.aett;
  nas = cfg.role == "nas";
  bulk = lib.filter (dir: nas && dir.bulk) cfg.state;

  # State outside what persist.nix keeps anyway; /home only on a machine with the fleet's user.
  kept =
    dir:
    lib.any (root: dir.path == root || lib.hasPrefix "${root}/" dir.path) (
      [
        "/var/lib"
        "/var/log"
      ]
      ++ lib.optional (cfg.user != null) "/home"
    );
in
{
  aett.persist = map (dir: dir.path) (lib.filter (dir: !(nas && dir.bulk) && !kept dir) cfg.state);

  fileSystems = lib.listToAttrs (
    map (dir: {
      name = dir.path;
      value = {
        device = "/tank${dir.path}";
        fsType = "none";
        options = [
          "bind"
          "x-systemd.requires=aett-tank.service"
          "x-systemd.after=aett-tank.service"
        ];
      };
    }) bulk
  );

  # A fresh tank is empty, so the bind sources are made once it is mounted and before the binds.
  systemd.services.aett-tank = lib.mkIf (bulk != [ ]) {
    description = "Create the directories bind-mounted from /tank";
    unitConfig = {
      DefaultDependencies = false;
      RequiresMountsFor = [ "/tank" ];
    };
    before = map (dir: "${utils.escapeSystemdPath dir.path}.mount") bulk ++ [ "local-fs.target" ];
    wantedBy = [ "local-fs.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = lib.concatMapStrings (dir: ''
      mkdir -p ${lib.escapeShellArg "/tank${dir.path}"}
    '') bulk;
  };
}
