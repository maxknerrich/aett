# The `aett` options fleet.json sets on every machine, NixOS or nix-darwin. aett validated the fleet
# before writing it, so the types here only describe its shape. Modules for one kind of machine declare
# their own: disk, vm, guests and the like.
{ lib, ... }:
let
  inherit (lib) mkOption types;

  tailnet = types.nullOr (
    types.submodule {
      options = {
        address = mkOption { type = types.str; };
        # Its MagicDNS name, <machine>.<tailnet>.ts.net.
        name = mkOption { type = types.str; };
      };
    }
  );
in
{
  options.aett = {
    name = mkOption { type = types.str; };
    role = mkOption {
      type = types.enum [
        "hypervisor"
        "nas"
        "server"
        "computer"
      ];
    };
    # Selects the nixpkgs input in flake.nix; recorded here so fleet.json passes through unchanged.
    channel = mkOption {
      type = types.enum [
        "stable"
        "unstable"
      ];
    };
    operator.sshKeys = mkOption { type = types.listOf types.str; };

    # Package names by the source state/pins.json picked for each.
    packages = mkOption {
      type = types.attrsOf (types.listOf types.str);
      default = { };
    };
    # GitHub releases as state/pins.json pins them: a binary, its version and an asset per platform.
    releases = mkOption {
      type = types.listOf types.attrs;
      default = [ ];
    };
    # Homebrew casks; only Macs install them.
    apps = mkOption {
      type = types.listOf types.str;
      default = [ ];
    };

    tailscale = {
      tag = mkOption { type = types.str; };
      # A Mac that runs the Tailscale app, which aett leaves to it.
      app = mkOption {
        type = types.bool;
        default = false;
      };
    };
    # The machine on the tailnet, once it joined.
    tailnet = mkOption {
      type = tailnet;
      default = null;
    };

    # The fleet's user, on every machine but a hypervisor. `password` says whether its hash exists.
    user = mkOption {
      type = types.nullOr (
        types.submodule {
          options = {
            name = mkOption { type = types.str; };
            password = mkOption { type = types.bool; };
          };
        }
      );
      default = null;
    };

    # The secrets this machine reads, each a sops file in the build that sops-nix puts at
    # /run/secrets/<name>.
    secrets = mkOption {
      type = types.listOf (
        types.submodule {
          options = {
            name = mkOption { type = types.str; };
            file = mkOption { type = types.str; };
          };
        }
      );
      default = [ ];
    };

    # The plugins on this machine: as an instance or as a client of the instances, with the entry's
    # options and every machine the plugin configures as a peer.
    services = mkOption {
      type = types.attrsOf (
        types.submodule {
          options = {
            instance = mkOption { type = types.bool; };
            options = mkOption {
              type = types.attrsOf types.anything;
              default = { };
            };
            peers = mkOption {
              type = types.listOf (
                types.submodule {
                  options = {
                    name = mkOption { type = types.str; };
                    instance = mkOption { type = types.bool; };
                    tailnet = mkOption { type = tailnet; };
                    # The SHA-256 of each certificate the plugin made for this peer, by secret.
                    fingerprints = mkOption {
                      type = types.attrsOf types.str;
                      default = { };
                    };
                  };
                }
              );
              default = [ ];
            };
          };
        }
      );
      default = { };
    };

    # Directories the plugins on this machine keep; bulk ones land on a NAS's tank.
    state = mkOption {
      type = types.listOf (
        types.submodule {
          options = {
            path = mkOption { type = types.str; };
            bulk = mkOption { type = types.bool; };
          };
        }
      );
      default = [ ];
    };

    # Ports this machine's plugins serve on the tailnet. Caddy serves the web ones over HTTPS.
    endpoints = mkOption {
      type = types.listOf (
        types.submodule {
          options = {
            service = mkOption { type = types.str; };
            name = mkOption { type = types.str; };
            port = mkOption { type = types.port; };
            web = mkOption { type = types.bool; };
          };
        }
      );
      default = [ ];
    };

    darwin.system = mkOption {
      type = types.nullOr types.str;
      default = null;
    };
  };
}
