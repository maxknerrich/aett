{
  description = "aett: pinned inputs and NixOS modules";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      installer =
        system:
        (nixpkgs.lib.nixosSystem {
          modules = [
            "${nixpkgs}/nixos/modules/installer/cd-dvd/installation-cd-minimal.nix"
            ./installer.nix
            { nixpkgs.hostPlatform = system; }
          ];
        }).config.system.build.isoImage;
    in
    {
      packages = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: {
        installer = installer system;
      });
    };
}
