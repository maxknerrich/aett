# The tools stacks declare, each pinned by the fleet: packages from nixpkgs on the machine's channel,
# `unstable` from nixpkgs unstable, and `fast` from llm-agents.nix or, as `releases`, GitHub releases.
{
  config,
  lib,
  pkgs,
  sources,
  ...
}:
let
  cfg = config.aett;
  inherit (pkgs.stdenv.hostPlatform) system;

  # A nixpkgs attribute path such as "python3Packages.rich" in `set`.
  attribute = set: path: lib.getAttrFromPath (lib.splitString "." path) set;

  unstable = import sources.nixpkgs-unstable {
    inherit system;
    config = pkgs.config;
  };

  agent =
    name:
    sources.llm-agents.packages.${system}.${name}
      or (throw "fleet.ts lists ${name} under fast, but neither a release() nor llm-agents.nix provides it.");

  # A release asset unpacked, its binary installed and, when dynamically linked, patched for NixOS.
  release =
    tool:
    let
      asset =
        tool.assets.${system} or (throw "${tool.bin} ${tool.version} has no release asset for ${system}.");
    in
    pkgs.stdenv.mkDerivation {
      pname = tool.bin;
      inherit (tool) version;
      src = pkgs.fetchurl { inherit (asset) url hash; };
      nativeBuildInputs = [
        pkgs.autoPatchelfHook
        pkgs.unzip
      ];
      buildInputs = [ pkgs.stdenv.cc.cc.lib ];
      dontConfigure = true;
      dontBuild = true;
      unpackPhase = ''
        case "$src" in
          *.zip) unzip -q "$src" ;;
          *.tar*|*.tgz) tar -xf "$src" ;;
          *) cp "$src" ${lib.escapeShellArg tool.bin} ;;
        esac
      '';
      installPhase = ''
        found=$(find . -type f -name ${lib.escapeShellArg tool.bin} | head -n 1)
        if [ -z "$found" ]; then
          echo "${tool.bin} is not in ${asset.url}." >&2
          exit 1
        fi
        install -Dm755 "$found" "$out/bin/${tool.bin}"
      '';
    };
in
{
  options.aett = {
    # nixpkgs attribute paths such as "htop" or "python3Packages.rich".
    packages = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
    unstable = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
    # llm-agents.nix packages by name.
    fast = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
    # GitHub releases as state/pins.json pins them: a binary, its version and an asset per platform.
    releases = lib.mkOption {
      type = lib.types.listOf lib.types.attrs;
      default = [ ];
    };
  };

  config = {
    environment.systemPackages =
      map (attribute pkgs) cfg.packages
      ++ map (attribute unstable) cfg.unstable
      ++ map agent cfg.fast
      ++ map release cfg.releases;

    # Machines build llm-agents.nix's tools, and hosts their guests', from its cache.
    nix.settings = {
      extra-substituters = [ "https://cache.numtide.com" ];
      extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
    };
  };
}
