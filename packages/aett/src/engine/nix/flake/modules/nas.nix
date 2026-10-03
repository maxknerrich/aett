# A NAS's disks: two pools, each a btrfs RAID1 across disks that are each inside LUKS. root holds an
# ESP on every disk and @nix and @persist; tank is mounted at /tank for bulk state. Install records
# which disks form each pool. One passphrase opens every disk. / is a tmpfs.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.aett.pools;

  btrfsOptions = [
    "compress-force=zstd:3"
    "noatime"
  ];

  # disko formats a multi-device btrfs on the pool's last disk, naming the others' LUKS mappings;
  # it orders disks by name, so the names sort like the pool's order.
  member = pool: index: "${pool}${lib.fixedWidthString 2 "0" (toString index)}";
  members = pool: disks: lib.imap0 (index: _: member pool index) disks;
  isLast = disks: index: index == builtins.length disks - 1;

  luks = name: content: {
    type = "luks";
    inherit name;
    # The operator types the passphrase at the console or sends it with aett machine unlock; install
    # writes it here for formatting only.
    passwordFile = "/tmp/aett-luks-passphrase";
    settings.allowDiscards = true;
    inherit content;
  };

  raid1 = label: pool: disks: {
    type = "btrfs";
    extraArgs = [
      "-f"
      "-d"
      "raid1"
      "-m"
      "raid1"
      "-L"
      label
    ]
    ++ map (name: "/dev/mapper/${name}") (lib.init (members pool disks));
  };

  rootFs = raid1 "aett-root" "root" cfg.root // {
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

  tankFs = raid1 "aett-tank" "tank" cfg.tank // {
    mountpoint = "/tank";
    mountOptions = btrfsOptions;
  };

  # Where each root disk's ESP is mounted: the first at /boot, the others as copies of it.
  esp = index: if index == 0 then "/boot" else "/boot${toString index}";
in
{
  options.aett.pools = {
    # /dev/disk/by-id/ paths recorded in state at install.
    root = lib.mkOption { type = lib.types.listOf lib.types.str; };
    tank = lib.mkOption { type = lib.types.listOf lib.types.str; };
  };

  config = {
    disko.devices = {
      disk =
        lib.listToAttrs (
          lib.imap0 (index: device: {
            name = member "root" index;
            value = {
              type = "disk";
              inherit device;
              content = {
                type = "gpt";
                partitions = {
                  ESP = {
                    size = "1G";
                    type = "EF00";
                    content = {
                      type = "filesystem";
                      format = "vfat";
                      mountpoint = esp index;
                      mountOptions = [
                        "umask=0077"
                        "nofail"
                      ];
                    };
                  };
                  root = {
                    size = "100%";
                    content = luks (member "root" index) (if isLast cfg.root index then rootFs else null);
                  };
                };
              };
            };
          }) cfg.root
        )
        // lib.listToAttrs (
          lib.imap0 (index: device: {
            name = member "tank" index;
            value = {
              type = "disk";
              inherit device;
              content = luks (member "tank" index) (if isLast cfg.tank index then tankFs else null);
            };
          }) cfg.tank
        );
      nodev."/" = {
        fsType = "tmpfs";
        mountOptions = [
          "size=1G"
          "mode=755"
        ];
      };
    };

    # Mounted by label. Every disk must be there to boot: with one gone, mount the pool with
    # -o degraded from the console and replace the disk.
    fileSystems."/nix".device = lib.mkForce "/dev/disk/by-label/aett-root";
    fileSystems."/persist" = {
      device = lib.mkForce "/dev/disk/by-label/aett-root";
      neededForBoot = true;
    };
    fileSystems."/tank".device = lib.mkForce "/dev/disk/by-label/aett-tank";

    # Every root disk's ESP boots the same system: the others copy the first after each install.
    boot.loader.systemd-boot.extraInstallCommands = lib.concatMapStrings (index: ''
      if ${pkgs.util-linux}/bin/findmnt -rn -M ${esp index} >/dev/null; then
        ${pkgs.rsync}/bin/rsync -rt --delete /boot/ ${esp index}/
      fi
    '') (lib.range 1 (builtins.length cfg.root - 1));
  };
}
