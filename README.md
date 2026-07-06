# gdrive-dropbox-sync

Keeps a Google Drive folder and a Dropbox folder in sync with `rclone bisync`,
triggered in near-real-time by Drive/Dropbox push notifications instead of
polling on a fixed schedule.

## How it works

```
Google Drive  --(Drive API push notification)-->  Cloudflare Worker  --(repository_dispatch)-->  GitHub Actions --> rclone bisync
Dropbox       --(Dropbox webhook)               -->        ^
```

GitHub Actions can't receive inbound webhooks directly, so a small Cloudflare
Worker (`webhook-receiver/`) is the only externally-hosted piece. It verifies
each notification, debounces bursts, and fires a `repository_dispatch` event
that kicks off [`sync.yml`](.github/workflows/sync.yml), which runs
`rclone bisync` using the rclone config you already have locally.

### Known scoping limitation

Google Drive's push notification API has no way to watch a single folder's
contents — only the whole Drive (`changes.watch`) or a single file/folder's
own metadata (rename/trash), not "new file added inside this folder." So any
change anywhere in your Drive will cause a debounced check-in. `rclone
bisync` itself only ever touches the folder pair you configure below, so
nothing syncs to the wrong place — it just means occasional few-second no-op
runs triggered by unrelated Drive activity. Dropbox's app-scoped webhook has
a similar "something changed in the app's access" granularity.

### Conflict handling

Uses rclone bisync's default (`--conflict-resolve none`): if the same file
changed on both sides between runs, both versions are kept, each renamed with
a `.conflict` suffix — nothing is silently overwritten or lost.

## One-time setup

### 1. GitHub repo secrets/variables

Repo secrets (Settings → Secrets and variables → Actions → Secrets):

| Secret | Value |
|---|---|
| `RCLONE_CONF` | `base64 -i ~/.config/rclone/rclone.conf \| pbcopy` (must contain both the `gdrive` and `dropbox` remotes) |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with "Edit Cloudflare Workers" permission |
| `WORKER_BASE_URL` | e.g. `https://gdrive-dropbox-sync-webhook.<your-subdomain>.workers.dev` (known once you deploy the Worker once, step 3) |
| `GDRIVE_CHANNEL_TOKEN` | any long random string, e.g. `openssl rand -hex 32` — must match the Worker secret of the same name |

Repo variables (same page, Variables tab):

| Variable | Value |
|---|---|
| `GDRIVE_FOLDER` | path of the watched folder in the `gdrive` remote, e.g. `Synced` |
| `DROPBOX_FOLDER` | path of the watched folder in the `dropbox` remote, e.g. `Synced` |

### 2. Dropbox app + webhook

1. Create an app at the [Dropbox App Console](https://www.dropbox.com/developers/apps).
2. Note its **App secret** — you'll set this as the Worker's `DROPBOX_APP_SECRET`.
3. Under **Webhooks**, add `https://<your-worker-url>/dropbox` (after step 3 below gives you the URL). Dropbox will send a verification `GET` immediately; the Worker echoes it back.

### 3. Deploy the Worker

```bash
cd webhook-receiver
npm install
npx wrangler login
npx wrangler kv namespace create DEBOUNCE_KV   # copy the id into wrangler.toml
npx wrangler deploy
```

Fill in `wrangler.toml`'s `GITHUB_OWNER`/`GITHUB_REPO` and the KV namespace id
before deploying. After the first deploy, set the Worker's secrets:

```bash
npx wrangler secret put GITHUB_PAT            # fine-grained PAT, Contents: read & write, scoped to this repo
npx wrangler secret put DROPBOX_APP_SECRET
npx wrangler secret put GDRIVE_CHANNEL_TOKEN  # same value as the GitHub secret above
```

From here on, pushes to `webhook-receiver/**` on `main` redeploy it automatically
via [`deploy-worker.yml`](.github/workflows/deploy-worker.yml).

### 4. Register the Drive watch channel

Run the renewal workflow once by hand (Actions tab → "Renew Google Drive watch
channel" → Run workflow), or push to `main` and trigger it manually — it
registers the initial `changes.watch` channel pointed at the Worker.
[`renew-gdrive-watch.yml`](.github/workflows/renew-gdrive-watch.yml) then
re-runs every 12h automatically, since Drive channels expire and don't
self-renew.

### 5. First sync

Trigger [`sync.yml`](.github/workflows/sync.yml) manually once
(`workflow_dispatch`) to run the initial `--resync` baseline before relying on
webhook-triggered runs.

## Verifying it works

1. `curl "https://<worker-url>/dropbox?challenge=abc"` → should return `abc`.
2. Upload a test file into the watched Dropbox folder; watch `wrangler tail`
   for the incoming request and `repository_dispatch` call, then confirm a
   run appears under the repo's Actions tab and the file shows up in Drive.
3. Repeat by adding a file in the watched Drive folder.
4. Edit the same file on both sides between syncs and confirm both versions
   survive with a `.conflict` suffix after the next sync.
