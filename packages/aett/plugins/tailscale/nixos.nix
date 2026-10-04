# Tailscale on a NixOS machine: aett's way to reach it. The machine joins once, when aett installs or
# first applies it and the operator approves it; later boots keep its node.
{
  services.tailscale = {
    enable = true;
    # Tailscale's own UDP port; SSH and mosh on the tailnet are open like on the LAN.
    openFirewall = true;
  };
}
