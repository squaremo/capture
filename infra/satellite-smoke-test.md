# Satellite smoke test

Run this over SSH right after first boot (`ssh <user>@<house-id>.<tailnet>.ts.net`
or by local IP before Tailscale is confirmed up). Ordered so each step's
prerequisites are already confirmed by the one before it — if something
fails, stop and look there before moving on. Nothing here has been run
against real hardware yet; this is what to check, not a confirmation it
works. See `designs/satellite-provisioning.md`/`designs/satellite-hardware.md`
for the design this is testing.

## 1. cloud-init actually finished

```bash
cloud-init status --wait
```

Should print `status: done`. If it says `status: error`, the rest of
this checklist will fail in ways that trace back to this — go straight
to the logs instead of debugging further down:

```bash
sudo cloud-init status --long
sudo cat /var/log/cloud-init-output.log      # full run's stdout/stderr, in order
sudo cloud-init analyze show                 # per-module timing/errors
```

Two module failures are semi-expected right now and don't mean the box
is broken — see their own sections below rather than treating them as
blockers: the WM8960 driver build (§7) and `cage`/`seatd`'s seat access
(§8).

## 2. Tailscale joined and named correctly

```bash
tailscale status
```

Should show this device online with the hostname you set (`HOUSE_ID`).

```bash
tailscale status --json | jq -r '.Self.DNSName'
```

Note this value — it's what the TLS cert (§4) was minted for, and what
nginx will actually be reachable at from other devices.

## 3. Docker stack is up

```bash
sudo systemctl status capture-satellite.service
sudo systemctl status capture-satellite-sync.timer
cd /opt/capture-satellite/app && docker compose -f docker-compose.satellite.yml ps
```

Expect three containers (`satellite`, `nginx`, `watchtower`) all `Up`.
If `satellite` is restarting/crash-looping, check its logs before going
further — nothing past this point works without it:

```bash
docker compose -f docker-compose.satellite.yml logs satellite --tail 50
```

If the whole box feels sluggish over SSH around this point — high
iowait in `top`, a load average well above the core count — check for
two `docker compose` invocations running at once
(`ps aux | grep 'docker compose'`): `capture-satellite.service`'s own
startup and `capture-satellite-sync.service`'s first `OnBootSec=5min`
firing can land on top of each other. Should self-resolve once both
finish (each is `flock`-protected against the other now, so it's a
brief overlap at worst, not a standing race) — see "Real-boot finding:
concurrent docker compose invocations" in
`designs/satellite-provisioning.md`.

## 4. TLS cert was minted

```bash
sudo ls -la /etc/tailscale/certs/
```

Should show `app.crt`/`app.key`, dated from first boot. Missing files
usually mean "HTTPS Certificates" isn't enabled in the tailnet's DNS
settings (tailscale.com/admin/dns) — the `tailscale cert` step in
`runcmd` fails silently into the next step otherwise.

## 5. The satellite API responds

Directly (bypassing nginx):

```bash
curl -s http://localhost:4000/api/status | jq
```

Expect `{ house, capabilities, ready, playersFound, rooms }` — `house`
should match `HOUSE_ID`. `playersFound`/`rooms` being empty is expected
if there's no Sonos on this network yet, not a failure.

Through nginx, both ways it's meant to be reached:

```bash
curl -s http://localhost/config.json | jq              # the on-box kiosk's path
curl -sk https://$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')/config.json | jq
```

Both should return the same `{ defaultHouse, backendUrl }`. A hang
(not an error) on the second one usually means `BACKEND_URL` was set to
`http://` instead of `https://` somewhere, or the tailnet cert isn't
trusted yet — check with `-v` for where it's actually stalling.

## 6. Kiosk display

If you're near the screen: it should already be showing Station's
capture field, not the manual test page — if it's the test page, `nginx`
isn't in front of it correctly (re-check §5's `http://localhost/`
response) or the build being served is stale.

Over SSH, confirm the pieces are actually running rather than eyeballing
the screen:

```bash
systemctl status getty@tty1
ps aux | grep -E 'cage|chromium'
```

## 7. WM8960 audio driver

The one piece flagged as a real, not-yet-independently-verified risk in
`designs/satellite-hardware.md` — check rather than assume:

```bash
dkms status                          # expect: wm8960-soundcard/<version>, installed
aplay -l                              # expect: a card listing wm8960
arecord -l                           # same, for capture
```

If `dkms status` shows nothing or a build error, check why before
troubleshooting further:

```bash
dmesg | grep -i wm8960
cat /var/lib/dkms/wm8960-soundcard/*/build/make.log 2>/dev/null | tail -40
```

If it built but the card doesn't show in `aplay -l`/`arecord -l`, the
overlay may not have taken — check `/boot/firmware/config.txt` for
`dtoverlay=wm8960-soundcard`/`dtparam=i2s=on` lines and confirm this
machine actually rebooted after `install.sh` ran (the `power_state`
reboot at the end of the cloud-config — `last /` or `uptime` will show
whether a reboot happened at all).

Once the card shows up, an actual loopback test — speak into the mic,
hear it back on the speaker:

```bash
arecord -D plughw:wm8960soundcard -f S16_LE -d 5 /tmp/test.wav   # talk during this
aplay -D plughw:wm8960soundcard /tmp/test.wav
```

(Device name may differ — check the exact name `aplay -l`/`arecord -l`
reported and substitute it.)

## 8. If `cage`/`chromium` never started

Check for the seat-access failure flagged in `cloud-init-satellite.yaml.tpl`:

```bash
journalctl -u getty@tty1 --no-pager | tail -40
```

If it's a seat-access error, the account may need adding to a
`seatd`/`seat` group beyond `video`/`render`/`input` (name varies by
package version):

```bash
groups $(whoami)          # while SSH'd in as the kiosk account
getent group | grep -i seat
```

## 9. Auto-update is actually wired up

Not urgent to verify on day one, but worth confirming the mechanism
exists before trusting it long-term:

```bash
docker inspect capture-satellite-satellite-1 --format '{{.Config.Labels}}' | grep watchtower
sudo systemctl list-timers capture-satellite-sync.timer
```

Should show the Watchtower label present and the sync timer scheduled
(next run within 5 minutes of now).
