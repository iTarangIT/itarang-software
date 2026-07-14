# Live IoT Telemetry on Sandbox + Production — Setup Runbook

Goal: make `/ceo/intellicar` show **live** AWS RDS telemetry on sandbox and prod.

Both apps run on **one VPS (72.61.246.37, srv1233189)**, so **one persistent SSH tunnel**
serves both. Each app just points `IOT_DATABASE_URL` at `127.0.0.1:5500`.

```
sandbox-web ─┐
             ├─> 127.0.0.1:5500  ──(autossh tunnel)──> bastion 3.111.53.81 ──> RDS :5432 (private)
prod  -web  ─┘         on the VPS                        (ec2-user)          itarang-iot-db…
```

Only `IOT_DATABASE_URL` is used by the app (`IOT_BRIDGE_DATABASE_URL` is not consumed — skip it).

---

## Step 0 — Prerequisites (security; do these first)

These must happen before prod holds any of this, because the bastion key and the
`MYitarang2026` password were exposed in chat.

### 0a. Rotate the bastion key — generate it ON the VPS (private key never leaves the box)
```bash
# on the VPS as root
sudo mkdir -p /etc/iot-tunnel
sudo ssh-keygen -t ed25519 -f /etc/iot-tunnel/bastion_key -N "" -C "iot-tunnel@srv1233189"
sudo chmod 600 /etc/iot-tunnel/bastion_key
sudo cat /etc/iot-tunnel/bastion_key.pub      # copy this line
```
Then on the **bastion** (via your existing access or EC2 Instance Connect in the console):
```bash
# append the new pubkey, then REMOVE the old compromised itarang-bastion key line
nano ~/.ssh/authorized_keys
```

### 0b. Create a read-only DB user (don't put the master cred on the box)
Run as `itarang_admin` (via your existing tunnel `127.0.0.1:5500`, or pgAdmin):
```sql
CREATE ROLE dashboard_ro LOGIN PASSWORD '<new-strong-password>';
GRANT CONNECT ON DATABASE itarang TO dashboard_ro;
GRANT USAGE ON SCHEMA public TO dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard_ro;
-- future tables the poller/aggregator create:
ALTER DEFAULT PRIVILEGES FOR ROLE itarang_admin IN SCHEMA public
  GRANT SELECT ON TABLES TO dashboard_ro;
```
(The CRM only reads. Queries go through parent tables — `telemetry_can`, `vehicle_state`,
etc. — so SELECT on the parents is sufficient for the partitioned tables.)

### 0c. Lock the bastion security group
Change inbound SSH (port 22) from the temporary `0.0.0.0/0` to **`72.61.246.37/32`**
(the VPS). Add your own admin IP as a second rule only if you still need to tunnel from
your laptop.

### 0d. Keep the bastion alive
It's currently `itarang-bastion-temp`. Prod now depends on it, so **enable termination
protection** and don't stop it. (Longer term: a dedicated always-on `t4g.nano` bastion.)

> Optional but recommended: also rotate the RDS **master** password (`MYitarang2026`) and
> update the poller's Secrets Manager DSN `itarang/poller/pg-dsn`, then force-redeploy the
> poller. Independent of the CRM — the CRM will use `dashboard_ro`, not the master.

---

## Step 1 — Install the tunnel as a systemd service (on the VPS)

```bash
sudo apt-get update && sudo apt-get install -y autossh
```

Create `/etc/systemd/system/iot-tunnel.service`:
```ini
[Unit]
Description=SSH tunnel to AWS IoT RDS via bastion
After=network-online.target
Wants=network-online.target

[Service]
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new -o TCPKeepAlive=yes \
  -i /etc/iot-tunnel/bastion_key \
  -L 127.0.0.1:5500:itarang-iot-db.czqqi46oyf96.ap-south-1.rds.amazonaws.com:5432 \
  ec2-user@3.111.53.81
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
(If port 5500 is already taken on the box, pick another free local port and use it
consistently below.)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now iot-tunnel
sudo systemctl status iot-tunnel --no-pager
# connectivity check (no psql needed):
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/5500' && echo "port 5500 OPEN"
```

---

## Step 2 — Point the apps at the tunnel

Connection string (read-only user, via tunnel):
```
IOT_DATABASE_URL=postgres://dashboard_ro:<new-strong-password>@127.0.0.1:5500/itarang?sslmode=require
```

### Sandbox
```bash
sudo nano /home/itarang-sandbox/htdocs/sandbox.itarang.com/shared/.env   # set IOT_DATABASE_URL
sudo -iu itarang-sandbox pm2 reload sandbox-web --update-env
```
(Deploys don't overwrite sandbox `shared/.env`, so the box edit is durable.)

### Production
```bash
sudo nano /home/itarang-crm/htdocs/crm.itarang.com/shared/.env          # set IOT_DATABASE_URL
sudo -iu itarang-crm pm2 reload itarang-crm-web --update-env
```
**Also update the `PROD_ENV_FILE_B64` GitHub secret** with the same value — prod's
`shared/.env` is rewritten from that secret on **every deploy**, so a box-only edit reverts
on the next deploy.

---

## Step 3 — Verify

1. `sudo systemctl status iot-tunnel` → `active (running)`.
2. Open `https://sandbox.itarang.com/ceo/intellicar` and `https://crm.itarang.com/ceo/intellicar`:
   - KPI cards populated (not zeros), no "IoT VPS unreachable" degraded banner.
   - Fleet Devices table: fresh-battery units read **Healthy**; online-but-battery-silent
     units read **Battery Offline** (the new status).
   - Trip Analytics → pick a battery → AH Trend / Capacity Trend load.
3. Resilience: `sudo systemctl restart iot-tunnel` → dashboards recover within ~15s. If the
   tunnel is ever down the app already shows the graceful "tunnel down" banner, not an error.

---

## Notes
- One tunnel, both apps — no per-app tunnel needed.
- The app rebuilds its IoT pool when `IOT_DATABASE_URL` changes, so a `pm2 reload
  --update-env` is enough; no code deploy required for the env switch.
- Rollback: set `IOT_DATABASE_URL` back to the old VPS value and `pm2 reload`.
