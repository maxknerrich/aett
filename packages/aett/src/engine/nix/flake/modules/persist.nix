# Bind-mounts directories from /persist so they survive the tmpfs root. Install creates them.
{ config, lib, ... }:
{
  options.aett.persist = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [
      "/var/lib"
      "/var/log"
      "/etc/NetworkManager/system-connections"
    ];
  };

  config.fileSystems = lib.genAttrs config.aett.persist (dir: {
    device = "/persist${dir}";
    fsType = "none";
    options = [ "bind" ];
    neededForBoot = true;
  });
}
