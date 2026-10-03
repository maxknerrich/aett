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
        nix-darwin.lib.darwinSystem {
          modules = [
            sops-nix.darwinModules.sops
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
          tools = tools system;
        })
        // {
          aarch64-darwin.tools = tools "aarch64-darwin";
          x86_64-darwin.tools = tools "x86_64-darwin";
        };
    };
}
