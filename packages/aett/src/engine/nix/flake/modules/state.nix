# Where the plugins' state lives: on a NAS, bulk state on the tank pool; everything else on /persist,
# like /var/lib already is.
{ config, lib, ... }:
let
  cfg = config.aett;
  nas = cfg.role == "nas";
  bulk = lib.filter (dir: nas && dir.bulk) cfg.state;

  # State outside what persist.nix keeps anyway.
  kept =
    dir:
    lib.any (root: dir.path == root || lib.hasPrefix "${root}/" dir.path) [
      "/var/lib"
      "/var/log"
      "/home"
    ];
in
{
  aett.persist = map (dir: dir.path) (
    lib.filter (dir: !(nas && dir.bulk) && !kept dir) cfg.state
  );

  fileSystems = lib.listToAttrs (
    map (dir: {
      name = dir.path;
      value = {
        device = "/tank${dir.path}";
        fsType = "none";
        options = [
          "bind"
          "x-systemd.requires-mounts-for=/tank"
        ];
      };
    }) bulk
  );

  systemd.tmpfiles.rules = map (dir: "d /tank${dir.path} 0755 root root -") bulk;
}
