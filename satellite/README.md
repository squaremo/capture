# satellite

Local control node for one house. See `../designs/satellites.md` for the
design this implements.

This is currently a standalone vertical slice — UI → satellite →
local service — proving the wiring end to end, ahead of the central
backend calling into it. `services/sonos.js` is a stub standing in for
real Sonos UPnP control until there's hardware to test against; it exposes
the same shape a real implementation would, so it can be swapped in later
without changing `server.js`'s controller API.

## Run

    cd satellite
    npm install
    HOUSE_ID=home npm start

Open `http://localhost:4000`. `HOUSE_ID` is the only config for now —
it's what a real deployment would bake in at provisioning (see "Running
modes" in the design doc); on a laptop, just set it to whichever house
you're currently standing in and stop the process when you leave.
