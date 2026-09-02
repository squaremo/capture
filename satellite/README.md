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

## Dirigera (light control)

One-time pairing, done by hand, once per satellite:

    npx dirigera authenticate

Press the action button on the bottom of the hub within 60s of running
that. It prints an access token — set it as `DIRIGERA_ACCESS_TOKEN`
when starting the satellite:

    HOUSE_ID=home DIRIGERA_ACCESS_TOKEN=... npm start

The satellite connects via mDNS by default; set `DIRIGERA_HOST` to the
hub's IP if mDNS discovery doesn't reach it (e.g. across a VLAN
boundary). Without `DIRIGERA_ACCESS_TOKEN` set, `control_light` requests
routed to this satellite fail with "no Dirigera capability configured" —
same as an unconfigured house does for Sonos.
