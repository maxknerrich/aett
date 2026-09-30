# aett's one disk layout: a 1 GB ESP and a btrfs partition with @nix and @persist. / is a tmpfs.
{ config, lib, ... }:
let
  btrfsOptions = [
    "compress-force=zstd:3"
    "noatime"
  ];
in
{
  # A /dev/disk/by-id/ path recorded in state at install.
  options.aett.disk.device = lib.mkOption { type = lib.types.str; };

  config = {
    disko.devices = {
      disk.main = {
        type = "disk";
        inherit (config.aett.disk) device;
        content = {
          type = "gpt";
          partitions = {
            ESP = {
              size = "1G";
              type = "EF00";
              content = {
                type = "filesystem";
                format = "vfat";
                mountpoint = "/boot";
                mountOptions = [ "umask=0077" ];
              };
            };
            root = {
              size = "100%";
              content = {
                type = "btrfs";
                extraArgs = [ "-f" ];
                subvolumes = {
                  "@nix" = {
                    mountpoint = "/nix";
                    mountOptions = btrfsOptions;
                  };
                  "@persist" = {
                    mountpoint = "/persist";
                    mountOptions = btrfsOptions;
                  };
                };
              };
            };
          };
        };
      };
      nodev."/" = {
        fsType = "tmpfs";
        mountOptions = [
          "size=1G"
          "mode=755"
        ];
      };
    };

    fileSystems."/persist".neededForBoot = true;
  };
}
