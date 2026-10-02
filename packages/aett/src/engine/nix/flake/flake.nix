{
  description = "aett: pinned inputs and NixOS modules";

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
    microvm = {
      url = "github:microvm-nix/microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
      # Only an overlay aett doesn't use reads it; following this flake keeps it out of the lock.
      inputs.spectrum.follows = "";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
      disko,
      sops-nix,
      microvm,
      ...
    }:
    let
      inherit (nixpkgs) lib;

      # `aett compile` writes fleet.json and the facts next to this file in .aett/build/.
      fleet = if builtins.pathExists ./fleet.json then lib.importJSON ./fleet.json else { machines = { }; };

      channels = {
        stable = nixpkgs;
        unstable = nixpkgs-unstable;
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
            ./modules/disk.nix
            ./modules/install.nix
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

      machine =
        name: declared:
        channels.${declared.channel}.lib.nixosSystem {
          modules = [
            sops-nix.nixosModules.sops
            ./modules/machine.nix
            ./modules/persist.nix
            ./modules/tailscale.nix
            {
              _file = "fleet.ts -> machine(${name})";
              aett = declared // {
                inherit name;
                inherit (fleet) operator;
              };
            }
          ]
          ++ kind name declared
          ++ guests declared
          ++ lib.optional (declared.role == "hypervisor") ./modules/hypervisor.nix;
        };

      installer =
        system:
        (nixpkgs.lib.nixosSystem {
          modules = [
            "${nixpkgs}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix"
            ./installer.nix
            { nixpkgs.hostPlatform = system; }
          ];
        }).config.system.build.isoImage;

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
            pkgs.gitMinimal
          ];
        };
    in
    {
      nixosConfigurations = lib.mapAttrs machine fleet.machines;

      packages =
        lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
          installer = installer system;
          tools = tools system;
        })
        // {
          aarch64-darwin.tools = tools "aarch64-darwin";
          x86_64-darwin.tools = tools "x86_64-darwin";
        };
    };
}
