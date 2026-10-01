# A VM that its host builds and runs with microvm.nix. It shares the host's store read-only, keeps its
# state on a btrfs volume of its own and takes its SSH host key from a read-only share, mounted where
# metal machines keep theirs.
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

  # What the guest boots with that switching can't change. aett compares the running guest's copy
  # with the new system's to choose between switching in place and restarting the guest.
  boot = pkgs.writeText "aett-boot.json" (
    builtins.toJSON {
      inherit (config.microvm)
        hypervisor
        vcpu
        mem
        balloon
        ;
      interfaces = map (i: { inherit (i) type id mac; }) config.microvm.interfaces;
      shares = map (share: {
        inherit (share)
          tag
          source
          mountPoint
          readOnly
          ;
      }) config.microvm.shares;
      volumes = map (volume: {
        inherit (volume)
          image
          label
          mountPoint
          size
          fsType
          ;
      }) config.microvm.volumes;
      kernel = config.microvm.kernel;
      initrd = config.microvm.initrdPath;
      params = config.boot.kernelParams;
    }
  );
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
    # A guest with a home: the ports its host forwards to its SSH and mosh, from the LAN.
    forwards = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            ssh = lib.mkOption { type = lib.types.port; };
            mosh.from = lib.mkOption { type = lib.types.port; };
            mosh.to = lib.mkOption { type = lib.types.port; };
          };
        }
      );
    };
  };

  config = {
    microvm = {
      # A small device model on the host. A guest that needs a device it lacks, such as a GPU with
      # QEMU-only quirks, can take QEMU on its own.
      hypervisor = "cloud-hypervisor";
      vcpu = cfg.cpu;
      mem = cfg.memory;
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
          mountPoint = "/persist/etc/ssh";
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
    # Mounted in the initrd, so the key is there when activation decrypts secrets with it.
    fileSystems."/persist/etc/ssh".neededForBoot = true;

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

    system.systemBuilderCommands = "ln -s ${boot} $out/aett-boot";

    # mosh-server answers on the ports its host forwards, unless the client asks for others. mosh's
    # client sends to the address SSH reached, the host's, which forwards them here.
    environment.systemPackages = lib.mkIf (cfg.forwards != null) [
      (lib.hiPrio (
        pkgs.writeShellScriptBin "mosh-server" ''
          if [ "''${1:-}" = new ]; then
            shift
            exec ${pkgs.mosh}/bin/mosh-server new -p ${toString cfg.forwards.mosh.from}:${toString cfg.forwards.mosh.to} "$@"
          fi
          exec ${pkgs.mosh}/bin/mosh-server "$@"
        ''
      ))
    ];
    networking.firewall.allowedUDPPortRanges = lib.mkIf (cfg.forwards != null) [
      {
        inherit (cfg.forwards.mosh) from to;
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
