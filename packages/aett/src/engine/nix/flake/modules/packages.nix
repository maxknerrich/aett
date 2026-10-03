# The packages a machine's entries list, each pinned by the fleet: from llm-agents.nix, nixpkgs on the
# machine's channel or nixpkgs unstable, as state/pins.json picked for its name, and GitHub releases.
# `aett.pkgs` holds each by name for plugins' modules. NixOS and nix-darwin alike.
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

  # An attribute path such as "python3Packages.rich" in `set`.
  attribute = set: path: lib.getAttrFromPath (lib.splitString "." path) set;

  unstable = import sources.nixpkgs-unstable {
    inherit system;
    config = pkgs.config;
  };

  sets = {
    "llm-agents" = sources.llm-agents.packages.${system};
    nixpkgs = pkgs;
    inherit unstable;
  };

  # A release asset unpacked and its binary installed; on Linux a dynamically linked one is patched.
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
      nativeBuildInputs = [ pkgs.unzip ] ++ lib.optional pkgs.stdenv.isLinux pkgs.autoPatchelfHook;
      buildInputs = lib.optional pkgs.stdenv.isLinux pkgs.stdenv.cc.cc.lib;
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

  resolved = lib.concatMapAttrs (
    source: names: lib.genAttrs names (attribute sets.${source})
  ) cfg.packages;
in
{
  options.aett.pkgs = lib.mkOption {
    type = lib.types.attrsOf lib.types.package;
    readOnly = true;
    description = "Every package this machine lists, by name, from the source the fleet pinned.";
  };

  config = {
    aett.pkgs = resolved;

    environment.systemPackages = lib.attrValues resolved ++ map release cfg.releases;

    # Machines take llm-agents.nix's tools, and hosts their guests', from its cache. A Mac's
    # darwin/machine.nix says so in the installer's nix.conf instead.
    nix.settings = lib.mkIf pkgs.stdenv.isLinux {
      extra-substituters = [ "https://cache.numtide.com" ];
      extra-trusted-public-keys = [ "niks3.numtide.com-1:DTx8wZduET09hRmMtKdQDxNNthLQETkc/yaX7M4qK0g=" ];
    };
  };
}
