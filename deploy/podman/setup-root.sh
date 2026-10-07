#!/bin/sh
# One-time root setup on the server: Podman and the Apache site with HTTPS.
# Run with sudo once the DNS record for $DOMAIN points to this host.
set -eu
DOMAIN="${1:-rommancer.example.com}"
PORT="${2:-8096}"
apt-get install -y podman uidmap slirp4netns
cat > "/etc/apache2/sites-available/$DOMAIN.conf" <<CONF
<VirtualHost *:80>
    ServerName $DOMAIN
    ProxyPreserveHost On
    ProxyTimeout 3600
    RequestHeader set X-Forwarded-Proto "http"
    ProxyPass        / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
</VirtualHost>
CONF
a2enmod proxy proxy_http headers >/dev/null
a2ensite "$DOMAIN" >/dev/null
apache2ctl configtest
systemctl reload apache2
# certbot copies the vhost to *-le-ssl.conf with HTTPS and redirects HTTP to it
certbot --apache -d "$DOMAIN" --redirect --non-interactive --agree-tos --keep-until-expiring
sed -i 's/X-Forwarded-Proto "http"/X-Forwarded-Proto "https"/' "/etc/apache2/sites-available/$DOMAIN-le-ssl.conf"
systemctl reload apache2
echo "OK: https://$DOMAIN -> 127.0.0.1:$PORT"
