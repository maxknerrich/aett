# Bind-mounts directories from /persist so they survive the tmpfs root. Install creates them on metal; guest.nix on a VM's fresh volume.
{ config, lib, ... }:
{
  options.aett.persist = lib.mkOption {
    type = lib.types.listOf lib.types.str;
  };

  config = {
    aett.persist = [
      "/var/lib"
      "/var/log"
    ];

    fileSystems = lib.genAttrs config.aett.persist (dir: {
      device = "/persist${dir}";
      fsType = "none";
      options = [ "bind" ];
      neededForBoot = true;
    });

    # A directory added to the list later, such as /home, exists before a switch mounts it.
    system.activationScripts.aett-persist = lib.concatMapStrings (dir: ''
      mkdir -p /persist${dir}
    '') config.aett.persist;
  };
}
