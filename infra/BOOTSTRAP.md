# Bootstrap from scratch

A single ordered checklist for standing up the server from nothing. Skip
straight to step 3 if Tailscale/1Password are already set up from a
previous server.

## 1. Tailscale

- Confirm you're an **Owner/Admin** of the tailnet — check `tailscale.com/admin/users`. Required for the next two steps.
- At [tailscale.com/admin/dns](https://tailscale.com/admin/dns): enable **MagicDNS**, then **HTTPS Certificates**. Both are required — `tailscale cert` fails on the server without them.
- At [tailscale.com/admin/settings/keys](https://tailscale.com/admin/settings/keys): generate an auth key. Non-reusable is fine, it's used once at first boot.

## 2. 1Password

- Create the items referenced in [`production.env`](production.env) — by default a vault called `Capture` containing an `anthropic` item with an `api_key` field, and a `linear` item with `api_key` and `team_id` fields. (Or edit `production.env` to reference whatever vault/item/field names you'd rather use — nothing else needs to change.)
  - Anthropic API key: [console.anthropic.com](https://console.anthropic.com)
  - Linear API key: in Linear, **Settings → Account → Security & access → API → Personal API keys → Create key**
  - Linear team UUID: in Linear, open the team, `Cmd/Ctrl+K` → **Copy model UUID** (not the short team key like `ENG` — the API rejects that)
  - Tip for getting the exact `op://vault/item/field` string for each: right-click the field in the 1Password app → **Copy Secret Reference** (needs "integrate with 1Password CLI" turned on in Settings → Developer first)
- Create a **Service Account** scoped to that vault, copy its token. This needs a 1Password plan that supports Service Accounts.
- Skip the `linear` item entirely (and delete/comment those two lines in `production.env`) if you don't want `create_linear_task` enabled.

## 3. Create the server

In the [Hetzner Cloud Console](https://console.hetzner.cloud):

- Image: **Ubuntu 24.04**
- Firewall: allow inbound **UDP 41641** (Tailscale) only — app traffic arrives over the Tailscale interface, not the public one, so 80/443 don't need to be open publicly
- No SSH key — cloud-init does the whole setup; use Hetzner's browser **Console** (with the emailed root password) for emergency access later
- In **Cloud config / User data**, paste the contents of [`cloud-init.yaml.tpl`](cloud-init.yaml.tpl) with these placeholders filled in directly in Hetzner's box, so nothing sensitive has to go anywhere else:
  - `${server_name}` → e.g. `capture`
  - `${tailscale_auth_key}` → the key from step 1
  - `${tailscale_fqdn}` → `<server_name>.<your-tailnet>.ts.net`
  - `${op_service_account_token}` → the token from step 2 — the only secret typed in at bootstrap
  - `${repo_url}` → `https://github.com/squaremo/capture.git`

## 4. Verify

Takes ~2 minutes (Docker, Tailscale join, TLS cert, clone, start). Check progress via the Hetzner **Console**:

```bash
cloud-init status
journalctl -u capture -n 50 --no-pager
```

Confirm the device shows up at `tailscale.com/admin/machines`, then open `https://<server_name>.<tailnet>.ts.net` from a Tailscale-connected device.

## After this

Nothing here needs repeating. Ongoing deploys, config changes, and secret additions all flow through `git push` — see the main [README](../README.md#how-deployment-works). The Hetzner Console is only for genuine emergencies from here on; it doesn't reliably support pasting, so anything typed there should be short (a Console session is not the place to hand-type a long secret if it can be avoided — route new secrets through `production.env` + 1Password instead).

Note: Hetzner has no way to re-apply new cloud-init/user-data to an existing server short of a full **rebuild**, which reinstalls the OS and wipes the disk (including captured data in `/opt/capture/data`). Don't do that to fix a config mistake — edit files directly on the running server instead.
