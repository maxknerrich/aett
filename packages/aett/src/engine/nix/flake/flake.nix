{
  description = "aett: pinned inputs and NixOS and nix-darwin modules";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Keeps its own nixpkgs, so its binary cache has what it builds.
    llm-agents.url = "github:numtide/llm-agents.nix";
    microvm = {
      url = "github:microvm-nix/microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
      # Only an overlay aett doesn't use reads it; following this flake keeps it out of the lock.
      inputs.spectrum.follows = "";
    };
    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Homebrew on Macs, installed and pinned by Nix.
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";
    # A Mac on nixpkgs unstable takes nix-darwin's development branch, which tracks it.
    nix-darwin-unstable = {
      url = "github:nix-darwin/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs-unstable";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
      disko,
      sops-nix,
      llm-agents,
      microvm,
      nix-darwin,
      nix-darwin-unstable,
      nix-homebrew,
      ...
    }:
    let
      inherit (nixpkgs) lib;

      # `aett compile` writes fleet.json, the facts and the plugins next to this file in .aett/build/.
      fleet = if builtins.pathExists ./fleet.json then lib.importJSON ./fleet.json else { machines = { }; };

      channels = {
        stable = nixpkgs;
        unstable = nixpkgs-unstable;
      };

      darwins = {
        stable = nix-darwin;
        unstable = nix-darwin-unstable;
      };

      # The other sources packages.nix takes tools from.
      sources = { inherit nixpkgs-unstable llm-agents; };

      # The modules of the plugins on a machine, for its system: plugins/<name>/<system>.nix.
      plugins =
        system: declared:
        lib.concatMap (
          name:
          let
            module = ./plugins/${name}/${system}.nix;
          in
          lib.optional (builtins.pathExists module) module
        ) (builtins.attrNames declared.services);

      # What fleet.json says about a machine, as the `aett` options.
      settings = name: declared: {
        _file = "fleet.ts -> machine(${name})";
        _module.args.sources = sources;
        aett = declared // {
          inherit name;
          inherit (fleet) operator;
        };
      };

      # A VM, which its host builds and runs, or bare metal, which aett installs.
      kind =
        name: declared:
        if declared ? vm then
          [
            microvm.nixosModules.microvm
            ./modules/guest.nix
            {
              # The host's hardware report says what it runs; the VM runs the same.
              nixpkgs.hostPlatform = (lib.importJSON ./state/${declared.vm.host}/facter.json).system;
            }
          ]
        else
          [
            disko.nixosModules.disko
            ./modules/metal.nix
            (if declared.role == "nas" then ./modules/nas.nix else ./modules/disk.nix)
            ./modules/install.nix
            ./modules/unlock.nix
            { hardware.facter.reportPath = ./state/${name}/facter.json; }
          ];

      # A machine that runs VMs builds each guest's system from its entry here.
      guests =
        declared:
        lib.optionals (declared ? guests) [
          microvm.nixosModules.host
          ./modules/vm-host.nix
          {
            microvm.vms = lib.genAttrs declared.guests (guest: {
              evaluatedConfig = self.nixosConfigurations.${guest};
              # aett switches running guests itself and restarts them only when it must.
              restartIfChanged = false;
            });
          }
        ];

      nixos =
        name: declared:
        channels.${declared.channel}.lib.nixosSystem {
          modules = [
            sops-nix.nixosModules.sops
            ./modules/options.nix
            ./modules/secrets.nix
            ./modules/machine.nix
            ./modules/persist.nix
            ./modules/state.nix
            ./modules/endpoints.nix
            ./modules/user.nix
            ./modules/shell.nix
            ./modules/packages.nix
            (settings name declared)
          ]
          ++ kind name declared
          ++ guests declared
          ++ plugins "nixos" declared
          ++ lib.optional (declared.role == "hypervisor") ./modules/hypervisor.nix;
        };

      darwin =
        name: declared:
        darwins.${declared.channel}.lib.darwinSystem {
          modules = [
            sops-nix.darwinModules.sops
            nix-homebrew.darwinModules.nix-homebrew
            ./modules/options.nix
            ./modules/secrets.nix
            ./modules/packages.nix
            ./darwin/machine.nix
            ./darwin/user.nix
            ./darwin/shell.nix
            { nixpkgs.hostPlatform = declared.darwin.system; }
            (settings name declared)
          ]
          ++ plugins "darwin" declared;
        };

      isDarwin = _: declared: declared ? darwin;

      installer =
        system:
        (nixpkgs.lib.nixosSystem {
          modules = [
            "${nixpkgs}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix"
            ./installer.nix
            {
              nixpkgs.hostPlatform = system;
              # The commit it was built from, which its console shows.
              _module.args.revision = self.shortRev or self.dirtyShortRev or "unknown";
            }
          ];
        }).config.system.build.isoImage;

      # The installer as a kernel and initrd that a running Linux machine with Nix boots into through
      # kexec, without a USB stick. `aett-kexec <authorized_keys> [<profile>…]` adds an archive with
      # those keys, the networks NetworkManager knows there and the NetworkManager profiles given, loads
      # it all and restarts into it.
      installerKexec =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit
            ((nixpkgs.lib.nixosSystem {
              modules = [
                "${nixpkgs}/nixos/modules/installer/netboot/netboot-minimal.nix"
                ./installer.nix
                {
                  nixpkgs.hostPlatform = system;
                  _module.args.revision = self.shortRev or self.dirtyShortRev or "unknown";
                }
              ];
            }))
            config
            ;
        in
        pkgs.writeShellApplication {
          name = "aett-kexec";
          runtimeInputs = [
            pkgs.kexec-tools
            pkgs.cpio
            pkgs.gzip
            pkgs.coreutils
            pkgs.findutils
          ];
          text = ''
            # On the disk that holds /nix: the initrd is over a gigabyte, more than a root in memory may
            # have room for. kexec keeps its own copy once loaded.
            work=$(mktemp -d -p /nix/var)
            trap 'rm -rf "$work"' EXIT
            install -d -m 0700 "$work/aett/root/.ssh"
            install -m 0600 "$1" "$work/aett/root/.ssh/authorized_keys"
            shift
            # NetworkManager's profile directories, a runtime profile shadowing a persistent one and that
            # one a shipped one with its UUID. A profile tied to an interface name could miss the
            # installer's, which names interfaces its own way.
            carried="$work/aett/etc/NetworkManager/system-connections"
            install -d -m 0700 "$carried"
            seen=" "
            for directory in /run /etc /usr/lib; do
              for profile in "$directory"/NetworkManager/system-connections/*.nmconnection; do
                [ -f "$profile" ] || continue
                uuid=$(sed -n 's/^uuid=//p' "$profile" | head -n 1)
                if [ -n "$uuid" ]; then
                  case "$seen" in *" $uuid "*) continue ;; esac
                  seen="$seen$uuid "
                fi
                copy="$carried/''${directory##*/}-''${profile##*/}"
                sed '/^interface-name=/d' "$profile" > "$copy"
                chmod 0600 "$copy"
              done
            done
            # The profiles aett made for the machine's fixed addresses.
            for profile in "$@"; do
              install -m 0600 "$profile" "$carried/''${profile##*/}"
            done
            (cd "$work" && find aett | cpio -o -H newc --quiet | gzip -9) > "$work/aett.cpio.gz"
            cat ${config.system.build.netbootRamdisk}/initrd "$work/aett.cpio.gz" > "$work/initrd"
            kexec --load ${config.system.build.kernel}/${config.system.boot.loader.kernelFile} \
              --initrd="$work/initrd" \
              --command-line "init=${config.system.build.toplevel}/init ${toString config.boot.kernelParams}"
            # In a moment, so the command that started this returns first.
            systemd-run --on-active=2 systemctl kexec
          '';
        };

      # Controllers run the tools aett shells out to from this pin.
      tools =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.buildEnv {
          name = "aett-tools";
          paths = [
            pkgs.openssh
            pkgs.sops
            pkgs.age
            pkgs.ssh-to-age
            pkgs.mkpasswd
            pkgs.gitMinimal
            pkgs.openssl
            pkgs.tailscale
            # GNU tools for the scripts aett runs on the Mac it applies to.
            pkgs.coreutils
          ];
        };

      # Whether `set` has a derivation at attribute path `name` that builds on `system`.
      provides =
        system: set: name:
        let
          tried = builtins.tryEval (
            let
              value = lib.attrByPath (lib.splitString "." name) null set;
            in
            value != null && lib.isDerivation value && lib.meta.availableOn (lib.systems.elaborate system) value
          );
        in
        tried.success && tried.value;
    in
    {
      nixosConfigurations = lib.mapAttrs nixos (lib.filterAttrs (name: m: !isDarwin name m) fleet.machines);
      darwinConfigurations = lib.mapAttrs darwin (lib.filterAttrs isDarwin fleet.machines);

      lib = {
        # The package names of each Nix registry, for the editor to complete in fleet.ts. Attribute
        # names are the same on every system.
        names = {
          nixpkgs = builtins.attrNames nixpkgs.legacyPackages.x86_64-linux;
          unstable = builtins.attrNames nixpkgs-unstable.legacyPackages.x86_64-linux;
          llm-agents = lib.unique (lib.concatMap builtins.attrNames (builtins.attrValues llm-agents.packages));
        };

        # The source of each package name on `system` for a machine on `channel`, first come first
        # served: llm-agents.nix, nixpkgs on that channel, nixpkgs unstable. aett pins the answer in the
        # fleet's state/pins.json.
        sources =
          system: channel: names:
          lib.genAttrs names (
            name:
            if provides system (llm-agents.packages.${system} or { }) name then
              "llm-agents"
            else if provides system channels.${channel}.legacyPackages.${system} name then
              "nixpkgs"
            else if provides system nixpkgs-unstable.legacyPackages.${system} name then
              "unstable"
            else
              null
          );
      };

      packages =
        lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
          installer = installer system;
          installer-kexec = installerKexec system;
          tools = tools system;
        })
        // {
          aarch64-darwin.tools = tools "aarch64-darwin";
          x86_64-darwin.tools = tools "x86_64-darwin";
        };
    };
}
