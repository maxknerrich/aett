# A VM that its host builds and runs with microvm.nix. It shares the host's store read-only, keeps its
# state on a btrfs volume of its own and takes its SSH host key from a read-only share.
{
  config,
  lib,
  pkgs,
  utils,
  ...
}:
let
  cfg = config.aett.vm;
  inherit (config.aett) name;
in
{
  options.aett.vm = {
    # The machine that builds and runs it, which also decides its platform in flake.nix.
    host = lib.mkOption { type = lib.types.str; };
    cpu = lib.mkOption { type = lib.types.ints.positive; };
    # Memory and the state volume's size, in MiB.
    memory = lib.mkOption { type = lib.types.ints.positive; };
    disk = lib.mkOption { type = lib.types.ints.positive; };
    address = lib.mkOption { type = lib.types.str; };
    prefixLength = lib.mkOption { type = lib.types.int; };
    gateway = lib.mkOption { type = lib.types.str; };
    mac = lib.mkOption { type = lib.types.str; };
    # The host's tap device; vm-host.nix bridges every vm-* device.
    tap = lib.mkOption { type = lib.types.str; };
  };

  config = {
    microvm = {
      hypervisor = "qemu";
      vcpu = cfg.cpu;
      # QEMU's microvm machine hangs with exactly 2 GiB: https://github.com/microvm-nix/microvm.nix/issues/171
      mem = if cfg.memory == 2048 then 2047 else cfg.memory;
      # Idle guests hand free pages back to the host.
      balloon = true;
      interfaces = [
        {
          type = "tap";
          id = cfg.tap;
          inherit (cfg) mac;
        }
      ];
      shares = [
        {
          tag = "ro-store";
          source = "/nix/store";
          mountPoint = "/nix/.ro-store";
          proto = "virtiofs";
          # virtiofsd's own bind mount would otherwise let the guest write the host's store.
          readOnly = true;
        }
        {
          # Where aett puts the guest's host key on the host; vm-host.nix keeps microvm's state there.
          tag = "identity";
          source = "/persist/microvms/${name}/identity";
          mountPoint = "/run/identity";
          proto = "virtiofs";
          readOnly = true;
        }
      ];
      # Files made in the guest's directory from now on are not copy-on-write, so btrfs doesn't
      # fragment the state volume. microvm.nix tries this on the image itself without chattr on its PATH.
      preStart = ''
        ${pkgs.e2fsprogs}/bin/chattr +C . || true
      '';
      # A sparse file on the host, made and formatted when the guest first starts.
      volumes = [
        {
          image = "state.img";
          label = "persist";
          mountPoint = "/persist";
          size = cfg.disk;
          fsType = "btrfs";
        }
      ];
    };

    fileSystems."/persist" = {
      neededForBoot = true;
      options = [
        "compress-force=zstd:3"
        "noatime"
      ];
    };

    # A fresh volume is empty, so the bind sources persist.nix mounts are made before their mounts.
    boot.initrd.systemd.services.aett-persist = {
      description = "Create the directories bind-mounted from /persist";
      unitConfig.DefaultDependencies = false;
      requires = [ "sysroot-persist.mount" ];
      after = [ "sysroot-persist.mount" ];
      before = map (dir: "${utils.escapeSystemdPath "/sysroot${dir}"}.mount") config.aett.persist;
      wantedBy = [ "initrd-fs.target" ];
      serviceConfig.Type = "oneshot";
      script = lib.concatMapStrings (dir: ''
        mkdir -p /sysroot/persist${dir}
      '') config.aett.persist;
    };

    services.openssh.hostKeys = [
      {
        path = "/run/identity/ssh_host_ed25519_key";
        type = "ed25519";
      }
    ];

    networking.useDHCP = false;
    networking.nameservers = [
      "9.9.9.9"
      "149.112.112.112"
    ];
    systemd.network.networks."10-guests" = {
      matchConfig.MACAddress = cfg.mac;
      address = [ "${cfg.address}/${toString cfg.prefixLength}" ];
      gateway = [ cfg.gateway ];
      dns = config.networking.nameservers;
      networkConfig.LinkLocalAddressing = "no";
    };
  };
}
