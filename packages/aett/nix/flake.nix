{
  description = "aett: pinned inputs and NixOS modules";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      nixpkgs-unstable,
      disko,
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

      machine =
        name: declared:
        channels.${declared.channel}.lib.nixosSystem {
          modules = [
            disko.nixosModules.disko
            ./modules/machine.nix
            ./modules/disk.nix
            ./modules/persist.nix
            {
              _file = "fleet.ts -> machine(${name})";
              aett = declared // {
                inherit name;
                inherit (fleet) operator;
              };
              hardware.facter.reportPath = ./state/${name}/facter.json;
            }
          ];
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
          paths = [ pkgs.openssh ];
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
        };
    };
}
