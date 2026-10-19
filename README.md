# WebSocket Chat — Microsoft Edge extension + Node.js server

Real-time chat rooms that live in Edge's **side panel**, so the chat stays open while you browse.

```
edge-websocket-chat/
├── extension/          # Load this folder in Edge (Manifest V3)
│   ├── manifest.json
│   ├── background.js   # makes the toolbar icon open the side panel
│   ├── sidepanel.html / .css / .js   # the chat UI + WebSocket client
│   └── icons/
└── server/             # Node.js WebSocket server (uses the `ws` package)
    ├── package.json
    └── server.js
```

**Features:** multiple rooms, user list, typing indicator, last 50 messages of history for people who join late,
auto-reconnect with backoff, clickable links, light/dark theme, optional shared access key, rate limiting,
heartbeat to drop dead connections.

---

## 1. Quick start (everything on your own PC)

### Start the server

You need **Node.js 18 or newer** (`node --version`). If you don't have it:

```powershell
winget install OpenJS.NodeJS.LTS
```

Then:

```powershell
cd edge-websocket-chat\server
npm install
npm start
```

You should see `Chat server listening on ws://localhost:8080`.
Check it in a browser: <http://localhost:8080/health> should print `ok`.

### Install the extension in Edge (Edge 114 or newer)

1. Open `edge://extensions`.
2. Turn on **Developer mode** (toggle in the left sidebar).
3. Click **Load unpacked** and select the `edge-websocket-chat\extension` folder.
4. Click the **Extensions** (puzzle-piece) button in the toolbar, then click the eye icon next to *WebSocket Chat* so the icon stays on the toolbar.
5. Click the chat icon. The side panel opens.
6. Enter the server URL `ws://localhost:8080`, a nickname, and a room. Click **Join room**.

To test with two people on one PC, open a second Edge profile (or an InPrivate window if you allow the
extension there), and join the same room with another nickname.

> After you change the extension's code, click **Reload** on its card in `edge://extensions`, then reopen the side panel.
> To debug the panel, right-click inside it and choose **Inspect**.

---

## 2. Server configuration

The server reads environment variables:

| Variable     | Default         | Meaning |
|--------------|-----------------|---------|
| `PORT`       | `8080`          | TCP port to listen on |
| `HOST`       | all interfaces  | Set `127.0.0.1` when the server sits behind a reverse proxy, so the raw port isn't reachable from outside |
| `CHAT_TOKEN` | *(empty)*       | Optional shared access key. If set, clients must enter it in the **Access key** field |

PowerShell example:

```powershell
$env:PORT = "9000"; $env:CHAT_TOKEN = "my-long-random-key"; npm start
```

Generate a good random key:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

---

## 3. Choosing how to host the server

Pick the option that matches who needs to connect.

| Who chats | Option | Cost | URL people enter |
|---|---|---|---|
| Just you (testing) | **A. Local** | free | `ws://localhost:8080` |
| People on the same Wi-Fi/office network | **B. LAN** | free | `ws://192.168.x.x:8080` |
| Friends over the internet, while your PC is on | **C. Cloudflare quick tunnel** | free | `wss://<random>.trycloudflare.com` |
| Anyone, your PC can be off | **D. Render free tier** ⭐ | free, no card | `wss://<name>.onrender.com` |
| Long-term, always on | **E. VPS + HTTPS reverse proxy** | free on Oracle Cloud, otherwise ~$4–6/month | `wss://chat.yourdomain.com` |

> **Use `wss://` (TLS) whenever traffic crosses the internet.** Plain `ws://` sends messages and the access key unencrypted.

### A. Local

Covered by the Quick start above.

### B. LAN (same network)

1. Start the server as in the Quick start.
2. Find your PC's IP address: run `ipconfig` and look for **IPv4 Address** (e.g. `192.168.1.42`).
3. Allow the port through Windows Firewall. Run this in **PowerShell as Administrator**:

   ```powershell
   New-NetFirewallRule -DisplayName "WebSocket Chat 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
   ```

   Your Wi-Fi must be set to the **Private** network profile (Settings → Network & internet → Wi-Fi → your network).
4. Everyone enters `ws://192.168.1.42:8080` (your IP) as the server URL.

### C. Internet, quick: Cloudflare quick tunnel (no router setup)

This gives your local server a temporary public HTTPS address, so WSS works with no domain or certificate.

```powershell
winget install --id Cloudflare.cloudflared
# with the chat server already running in another terminal:
cloudflared tunnel --url http://localhost:8080
```

It prints a URL like `https://quiet-river-1234.trycloudflare.com`.
Everyone uses **`wss://quiet-river-1234.trycloudflare.com`** (`https` becomes `wss`).
The URL changes each time you restart the tunnel, and anyone who has it can connect, so set `CHAT_TOKEN`.
For a permanent address, create a named tunnel on your own domain (see Cloudflare's Tunnel docs).
`ngrok http 8080` works the same way.

### D. Free cloud hosting on Render (no credit card)

[Render](https://render.com)'s free web service runs the server in the cloud with HTTPS/WSS set up for you.
The repo includes a [`render.yaml`](render.yaml) Blueprint, so deploying takes a few clicks.

**What "free" means here** (per [Render's free-tier docs](https://render.com/docs/free)):

- The service **sleeps after 15 minutes without incoming traffic** and takes **about a minute to wake up**.
  - While anyone has the chat panel open, the extension sends a small keepalive message every 4 minutes, so the server stays awake.
  - When someone joins a sleeping server, the extension shows "waking up" and keeps retrying for up to 90 seconds.
- 750 free instance hours per month. That's enough for one service running 24/7.
- Chat history is lost whenever the service sleeps, restarts, or redeploys (it's kept in memory only).

**1. Put the project on GitHub.** Create an empty repository on github.com (private is fine), then run these commands
in the `edge-websocket-chat` folder (the one that contains `render.yaml`):

```powershell
git init
git add .
git commit -m "WebSocket chat"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/edge-websocket-chat.git
git push -u origin main
```

No Git? On the new repo's page, click **uploading an existing file** and drag in everything inside `edge-websocket-chat`,
including `render.yaml` (skip `node_modules` if you have one).

**2. Pick a region.** `render.yaml` uses `singapore`. If most of your users are elsewhere, change it to the closest of
`oregon`, `ohio`, `virginia` or `frankfurt` *before* the first deploy. The region can't be changed later.

**3. Deploy.** Sign up at [render.com](https://render.com) with your GitHub account, then go to **New → Blueprint**.
Pick your repository and click **Deploy Blueprint**. Wait until the service shows **Live** (the first build takes 1–3 minutes).

**4. Check it.** Open `https://websocket-chat-xxxx.onrender.com/health` (your service's URL is at the top of its page). It should show `ok`.

**5. Get the access key.** Render generated a random `CHAT_TOKEN` for you: open the service, go to **Environment**, and reveal/copy `CHAT_TOKEN`.
Share it only with people you want in the chat.

**6. Connect.** In the extension, use the server URL **`wss://websocket-chat-xxxx.onrender.com`** (`wss://` and no port) and paste the access key.

**Updating:** push to `main`, and Render redeploys automatically. Connected panels drop for a moment and reconnect by themselves.

<details>
<summary>Without the Blueprint (manual setup)</summary>

**New → Web Service** → pick the repo, then set:

- **Root Directory:** `server`
- **Build Command:** `npm ci --omit=dev`
- **Start Command:** `node server.js`
- **Instance Type:** Free
- **Environment variables:** `HOST` = `0.0.0.0`, `CHAT_TOKEN` = a random key
- **Health Check Path** (under Advanced): `/health`
</details>

<details>
<summary>Other free options and why they're not the default</summary>

- **Oracle Cloud Always Free:** a real Linux VM that is always on, with no sleeping. Set it up with option E below.
  - Signing up needs a credit card for identity verification.
  - You'll want a free domain for HTTPS, for example from DuckDNS.
  - Oracle [may reclaim idle Always Free instances](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm): CPU, network (and on Arm shapes, memory) use under 20% for 7 days. A quiet chat server can meet that rule.
- **Cloudflare Tunnel from your own PC** (option C) is free but only works while your PC is on.
- **No longer free for new accounts:** Fly.io (short trial only), Railway (one-time trial credit, then $1/month of credit),
  Koyeb (needs a card and a $29 pre-authorization since Feb 2026), Heroku. Glitch stopped hosting projects in 2025.
</details>

### E. Production: Linux VPS + Caddy (automatic HTTPS)

This assumes an Ubuntu/Debian VPS and a domain such as `chat.example.com` whose DNS **A record** points at the VPS's IP.

**1. Install Node.js and copy the server**

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo mkdir -p /opt/edge-websocket-chat
# copy the server/ folder from your PC, e.g.:  scp -r server user@your-vps:/tmp/  then:
sudo cp -r /tmp/server /opt/edge-websocket-chat/
cd /opt/edge-websocket-chat/server && sudo npm ci --omit=dev
```

**2. Run it as a service (systemd)** so it starts on boot and restarts if it crashes.

```bash
sudo useradd --system --no-create-home chat
sudo nano /etc/systemd/system/chat.service
```

```ini
[Unit]
Description=WebSocket chat server
After=network.target

[Service]
User=chat
WorkingDirectory=/opt/edge-websocket-chat/server
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Environment=HOST=127.0.0.1
Environment=CHAT_TOKEN=replace-with-your-random-key
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now chat
sudo systemctl status chat        # should be "active (running)"
journalctl -u chat -f             # live logs (joins/leaves)
```

**3. Put Caddy in front for HTTPS/WSS.** Caddy gets and renews a Let's Encrypt certificate automatically and proxies WebSockets with no extra settings.

```bash
sudo apt-get install -y caddy
sudo nano /etc/caddy/Caddyfile
```

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

**4. Open the firewall** for web traffic only (port 8080 stays private because `HOST=127.0.0.1`):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

**5. Test:** <https://chat.example.com/health> prints `ok`. In the extension, use **`wss://chat.example.com`**.

<details>
<summary>Using nginx instead of Caddy</summary>

WebSockets need the `Upgrade`/`Connection` headers forwarded. Get a certificate with `sudo certbot --nginx -d chat.example.com`.

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate / ssl_certificate_key lines are added by certbot

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;   # server pings every 30s, so idle sockets stay open
    }
}
```
</details>

<details>
<summary>Keeping it running on Windows instead</summary>

Use [pm2](https://pm2.keymetrics.io/):

```powershell
npm install -g pm2
cd edge-websocket-chat\server
$env:CHAT_TOKEN = "your-key"; pm2 start server.js --name chat
pm2 save
```

For start-on-boot on Windows, use the `pm2-windows-startup` package or a Task Scheduler task that runs `pm2 resurrect` at logon.
For internet access, combine it with option C (Cloudflare Tunnel) rather than opening router ports.
</details>

---

## 4. Message protocol

All frames are JSON text. You can use it to write other clients (web page, mobile app, bot).

| Direction | Message | Notes |
|---|---|---|
| client → server | `{"type":"join","name":"Duc","room":"lobby","token":"…"}` | Must be the first message, within 10 s. `token` only if `CHAT_TOKEN` is set |
| client → server | `{"type":"message","text":"hello"}` | Max 2000 characters, max 10 messages per 10 s |
| client → server | `{"type":"typing"}` | Relayed to others at most once per second |
| client → server | `{"type":"ping"}` | Keepalive, sent every 4 min. No reply. Keeps free hosts from sleeping while people are connected |
| server → client | `{"type":"welcome","you":{id,name,room},"users":[…],"history":[…]}` | Your name may get a suffix like `Duc (2)` if it's taken |
| server → client | `{"type":"message","id","from":{id,name},"text","ts"}` | Also sent back to the sender |
| server → client | `{"type":"system","text":"Alice joined","ts"}` | Join/leave notices |
| server → client | `{"type":"users","users":[{id,name}…]}` | Whenever the room's user list changes |
| server → client | `{"type":"typing","from":{id,name}}` | |
| server → client | `{"type":"error","message":"…"}` | |

Close codes **4000–4099** mean "don't auto-reconnect" (4000 join timeout, 4001 wrong access key).

Quick manual test from a terminal:

```powershell
npx wscat -c ws://localhost:8080
> {"type":"join","name":"Tester","room":"lobby"}
> {"type":"message","text":"hi from wscat"}
```

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| "Could not connect to ws://…" | Is the server running? Does `/health` load in the browser at the same host and port? |
| Works on your PC but not for others on the LAN | Use your IP, not `localhost`. Add the firewall rule. Make sure the network profile is *Private*. |
| Behind HTTPS/Cloudflare it fails with `ws://` | Use `wss://` (and no `:8080`) when the server is behind TLS. |
| "Invalid access key" | The key must match the server's `CHAT_TOKEN` exactly. |
| Render: joining takes ~1 minute | The free service was asleep. The panel retries automatically, so wait for it. |
| Render: build fails at `npm ci` | Make sure `server/package-lock.json` was committed along with `package.json`. |
| Chat shows "Unknown message type: ping" | The server is an older copy. Restart or redeploy it with the current `server.js`. |
| Icon click doesn't open the panel | Update Edge to 114 or newer, then reload the extension. You can also open the panel from Edge's sidebar/side panel menu. |
| Port already in use | Another program uses 8080. Start with `$env:PORT="9000"; npm start` and connect to `:9000`. |

---

## 6. Limitations and ideas for later

- **History is in memory.** It is lost when the server restarts or the last person leaves a room. Add SQLite or Redis to keep it.
- **No user accounts.** `CHAT_TOKEN` is one shared password, and nicknames are not reserved. For real identities, add login (for example OAuth) and issue per-user tokens.
- **The connection lives in the side panel.** Closing the panel disconnects you, and there are no notifications while it's closed. Moving the socket into the background service worker (with a keepalive) plus `chrome.notifications` would add that.
- **One server process.** To run several instances behind a load balancer, broadcast through Redis pub/sub.
- **Publishing:** to share the extension without Developer mode, submit it to the Edge Add-ons store through Microsoft Partner Center.
