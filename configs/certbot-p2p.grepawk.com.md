# Certbot setup for p2p.grepawk.com

## 1) Install certbot and nginx plugin

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install certbot python3-certbot-nginx
```

## 2) Install the systemd service

Copy the service file into systemd, reload, and enable it:

```bash
sudo cp /path/to/p2p.service /etc/systemd/system/p2p.service
sudo systemctl daemon-reload
sudo systemctl enable --now p2p.service
```

Check status and logs:

```bash
sudo systemctl status p2p.service
sudo journalctl -u p2p.service -f
```

## 2) Ensure DNS points to your server

Create/verify an A record:

- Host: `p2p`
- Value: your server public IPv4
- TTL: default

Wait for DNS to propagate.

## 3) Add the nginx site and reload nginx

Copy the nginx site config and enable it:

```bash
sudo cp /path/to/nginx-p2p.grepawk.com.conf /etc/nginx/sites-available/p2p.grepawk.com
sudo ln -s /etc/nginx/sites-available/p2p.grepawk.com /etc/nginx/sites-enabled/p2p.grepawk.com
```

Test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 4) Get and install the certificate

```bash
sudo certbot --nginx -d p2p.grepawk.com
```

Follow prompts to enable HTTPS and redirect HTTP to HTTPS.

## 5) Verify renewal

```bash
sudo certbot renew --dry-run
```

## 6) Reload nginx

```bash
sudo systemctl reload nginx
```

## Notes

- Certbot will update your nginx server block to include the SSL settings.
- If you used a nonstandard nginx config location, you may need to add an `include` in your main nginx config and reload nginx first.
