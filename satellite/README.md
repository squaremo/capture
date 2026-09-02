# satellite

Local control node for one house. See `../designs/satellites.md` for the
overall design and `../designs/matter-lighting.md` for the Dirigera piece
specifically.

`services/sonos.js` is still a stub standing in for real Sonos UPnP
control until there's hardware to test against — it exposes the same
shape a real implementation would, so it can be swapped in later without
changing `server.js`'s controller API. `services/dirigera.js` is real:
it talks to an actual Dirigera hub via the `dirigera` npm client.

## Run

    cd satellite
    npm install
    HOUSE_ID=home npm start

Open `http://localhost:4000`. `HOUSE_ID` is the only required config —
it's what a real deployment would bake in at provisioning (see "Running
modes" in the design doc); on a laptop, just set it to whichever house
you're currently standing in and stop the process when you leave.

Config can also come from a `.env` file in this directory (copy
`.env.example`) instead of inline env vars — `npm start`/`npm run dev`
pick it up automatically via Node's `--env-file-if-exists`, no dotenv
dependency needed. It's gitignored, same as the backend's `.env`; never
commit it, since it ends up holding the Dirigera access token below.

## Dirigera (light control)

One-time pairing, done by hand, once per satellite:

    npx dirigera authenticate

Press the action button on the bottom of the hub within 60s of running
that. If it times out, mDNS discovery probably isn't reaching the hub
(common on client-isolated Wi-Fi, or with a VPN active) — pass the hub's
IP directly instead:

    npx dirigera authenticate --gateway-IP <hub IP>

Either way it prints an access token. Put it (and the IP, if you needed
it above) in `.env`:

    HOUSE_ID=home
    DIRIGERA_ACCESS_TOKEN=...
    DIRIGERA_HOST=...

Without `DIRIGERA_ACCESS_TOKEN` set, `control_light` requests routed to
this satellite fail with "no Dirigera capability configured" — same as
an unconfigured house does for Sonos.
