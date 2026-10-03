# The ports this machine's plugins serve, on the tailnet only. Caddy serves each web endpoint over HTTPS
# at https://<machine>.<tailnet>.ts.net:<port> with the machine's ts.net certificate, which it gets
# from tailscaled, and proxies it to the service on 127.0.0.1:<port>. Other endpoints the service
# serves itself.
{ config, lib, ... }:
let
  cfg = config.aett;
  web = lib.filter (endpoint: endpoint.web) cfg.endpoints;
in
{
  networking.firewall.interfaces.tailscale0.allowedTCPPorts = map (endpoint: endpoint.port) cfg.endpoints;

  # Caddy binds the tailnet address before tailscaled has brought it up.
  boot.kernel.sysctl."net.ipv4.ip_nonlocal_bind" = lib.mkIf (web != [ ] && cfg.tailnet != null) 1;

  services.caddy = lib.mkIf (web != [ ] && cfg.tailnet != null) {
    enable = true;
    globalConfig = ''
      auto_https disable_redirects
    '';
    virtualHosts = lib.listToAttrs (
      map (endpoint: {
        name = "https://${cfg.tailnet.name}:${toString endpoint.port}";
        value = {
          listenAddresses = [ cfg.tailnet.address ];
          extraConfig = "reverse_proxy 127.0.0.1:${toString endpoint.port}";
        };
      }) web
    );
  };

  services.tailscale.permitCertUid = lib.mkIf (web != [ ] && cfg.tailnet != null) "caddy";
}
