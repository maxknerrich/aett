# aett's one disk layout: a 1 GB ESP and a btrfs partition with @nix and @persist, inside LUKS when encrypted. / is a tmpfs.
{ config, lib, ... }:
let
  cfg = config.aett.disk;

  btrfsOptions = [
    "compress-force=zstd:3"
    "noatime"
  ];

  btrfs = {
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
in
{
  options.aett.disk = {
    # A /dev/disk/by-id/ path recorded in state at install.
    device = lib.mkOption { type = lib.types.str; };
    encrypted = lib.mkOption {
      type = lib.types.bool;
      default = false;
    };
  };

  config = {
    disko.devices = {
      disk.main = {
        type = "disk";
        inherit (cfg) device;
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
              # The operator types the passphrase at the console on every boot; install writes it to passwordFile for formatting only.
              content =
                if cfg.encrypted then
                  {
                    type = "luks";
                    name = "crypted";
                    passwordFile = "/tmp/aett-luks-passphrase";
                    settings.allowDiscards = true;
                    content = btrfs;
                  }
                else
                  btrfs;
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
