# Station control board: indicators + volume

Status: BOM decided, not yet built. Refines the "Custom control board"
section of `designs/satellite-hardware.md` (indicator lights + volume +
PTT, planned there but undesigned) — this doc is that design. Read
`satellite-hardware.md` first for how this board fits into the kiosk box
as a whole (case, screen, WM8960 audio HAT, GPIO header availability).

**Changed from an earlier all-solderless version of this doc**: the two
LEDs and their resistors are now soldered directly onto the perma-proto
board, rather than crimped/spliced together off-board — a soldering iron
turned out to be available after all. This removes the earlier
resistor-to-LED butt-splice step entirely (the board's own copper traces
do that job now). The board-to-Pi cable stays solderless throughout, via
a PCB-mount JST-XH header soldered onto the board — see Build approach.

## Scope

This first model covers two indicator LEDs and a volume control only.
**Push-to-talk is deliberately deferred to the next model** — the board
and its connectors are being kept independent per-function (see Wiring
below) specifically so PTT can be added later without touching what's
already built.

- **White LED** — on/standby indicator.
- **Red LED** — live-mic indicator.
- **Volume control** — **changed from an incremental rotary encoder to a
  potentiometer + ADC.** A knob whose physical position directly
  corresponds to the volume level (fully left = off, fully right = max)
  was judged worth the extra part over an encoder's "turn to change, no
  hard stops" feel. The Pi's GPIO has no analog input, so this needs a
  small ADC — the **MCP3008** (8-channel, 10-bit, SPI, cheap and
  well-documented) — between the pot's wiper and the Pi. True *absolute
  digital* rotary encoders exist but are an industrial part with no
  cheap hobbyist breakout; a plain pot read through an ADC is the
  practical way to get "position = value." **The MCP3008 ships as a bare
  16-pin DIP chip, not a breakout module** — unlike the pot or the LEDs,
  it needs its own small soldered board to have anything to plug a cable
  into; see Build approach and Mounting below.
  - **Pot spec: 10kΩ, linear taper, detented.** 10kΩ is the standard
    value for feeding an ADC (low enough that noise/leakage don't matter,
    high enough not to load the 3.3V rail). **Linear, not audio/log
    taper** — audio taper exists to make a *purely analog* volume circuit
    sound evenly stepped to human hearing, but here the wiper voltage is
    digitised and mapped to a volume value in software, so the
    logarithmic curve belongs in that software mapping instead, and the
    pot itself should be plain linear. **Detented** (a.k.a. "indent")
    gives the soft tactile click feel on turning — the resistance
    element underneath is still fully continuous, so it wires and reads
    exactly like a plain pot, just with added tactile feedback.
  - **No built-in push-button** — unlike the KY-040 encoder this
    replaces, a plain pot has no SW leg. If a mute/shutdown/PTT button is
    still wanted alongside the volume knob, it now needs its own
    standalone momentary switch — see Open questions below.

## Build approach

Soldering is now in scope for the LEDs and their resistors only —
everything from the board's edge onward (the cable to the Pi, and the
pot/MCP3008 assembly, which lives separately from the LED board) stays
crimp-only, no solder.

1. **LEDs + resistors soldered onto the perma-proto board** — each LED's
   anode goes through its series resistor to a signal pad; both LEDs'
   cathodes can share a single ground trace on the board itself (real
   copper traces, unlike the earlier friction-only plan), so the board
   only needs to break out **3 nets**: white signal, red signal, shared
   ground.
2. **A JST-XH male header, PCB-mount/through-hole, soldered onto the
   board** at those 3 net pads — the one other solder job this build
   needs, and it's what lets the cable side stay fully solderless: a
   JST-XH female housing (crimped onto wire, no soldering) simply plugs
   onto this header and unplugs again freely.
3. **A second small soldered board for the MCP3008** — same technique as
   the LED board, just a separate piece of perma-proto sited near the
   pot rather than near the LEDs (keeps the pot's analog wiper wire run
   short). The MCP3008 sits in a **16-pin DIP socket** (soldered to the
   board — the socket takes the heat, not the chip, and lets the chip be
   pulled/replaced later), wired via board traces to a second JST-XH
   male header (SPI + power/GND pins) soldered the same way as the LED
   board's header. **JST-XH connectors for the pot's 3 legs** (two outer
   + wiper) run from the pot itself into this same board's header
   footprint, crimped rather than soldered — the pot isn't a soldered
   part, only the MCP3008 assembly is.
4. **Female Dupont crimp terminals at the Pi end** — pushed directly onto
   the Pi's 40-pin GPIO header pins, for the LED cable, the pot-to-MCP3008
   wiring, and the MCP3008's SPI connection to the Pi. This removes the
   need for a separate GPIO breakout HAT: the header pins are standard
   0.1"/2.54mm, the same pitch Dupont terminals are made for.

One crimp tool that handles both 2.54mm Dupont and JST-XH pitch covers
every crimped connection in the build (confirm before buying — most
small ratcheting "SN-28B"-style crimpers do, but not all).

## BOM

| # | Item | Spec | Qty | Notes |
|---|------|------|-----|-------|
| 1 | White LED | 5mm, standby/on indicator | 1 | soldered to the board |
| 2 | Red LED | 5mm, live-mic indicator | 1 | soldered to the board |
| 3 | Resistor, LED (white) | ~330Ω, 1/4W | 1 | soldered in-line on the board, GPIO is 3.3V logic |
| 4 | Resistor, LED (red) | ~220–330Ω, 1/4W | 1 | soldered in-line on the board — red LEDs often want less than white, check the LED's datasheet Vf if available |
| 5 | Potentiometer | 10kΩ, linear taper, detented | 1 | volume control — see Scope above for the pot vs. encoder decision and the taper/value reasoning; not board-mounted, wired independently |
| 6 | ADC | MCP3008 (8-channel, 10-bit, SPI), bare 16-pin DIP chip | 1 | the Pi has no analog input — reads the pot's wiper voltage and reports it over SPI; ships with no breakout board, see items 8/10/11 |
| 7 | Perma-proto / stripboard | ~half-size, 0.1" pitch | 2 | one for the LED circuit, a second small piece for the MCP3008 assembly (sited near the pot, not the LEDs) |
| 8 | 16-pin DIP socket | standard 0.3" DIP-16 | 1 | soldered to the second board; the MCP3008 chip plugs into this rather than being soldered directly, so it can be pulled/replaced |
| 9 | JST-XH male headers, PCB-mount/through-hole | 3-pin ×1 (LED board: white/red signal + shared GND), 3-pin ×1 (MCP3008 board, pot side: 3.3V/GND/wiper), 6-pin ×1 (MCP3008 board, Pi side: MOSI/MISO/SCLK/CS/3.3V/GND) | 3 | soldered onto their respective boards — the other solder jobs alongside items 1–4 and 8, each giving a plug/unplug point for its cable |
| 10 | JST-XH housings + crimp pins | matching the 3 male headers above (two 3-pin, one 6-pin) | 3 housings, ~12 pins | a small assorted JST-XH kit (2/3/4/6-pin housings + pins) covers this |
| 11 | Female Dupont crimp terminals + housings | 2.54mm pitch, single-row | ~12 (one per signal; shared GND/power legs can reuse Pi pins instead of needing separate terminals) | pushes directly onto the Pi GPIO header; replaces a breakout HAT entirely |
| 12 | Crimp tool | handles both Dupont (2.54mm) and JST-XH pitch | 1 | confirm both-pitch support before buying |
| 13 | Hookup wire | 22–26AWG, a few colours | short lengths | cable-side legs only — no wire needed on the boards themselves beyond the soldered leads/traces |
| 14 | Solder + iron | fine 0.6–0.8mm solder | — | for items 1–4, the DIP socket (item 8), and both boards' JST headers (item 9) — a handful of simple through-hole joints on two small boards, not a full board's worth |

Sharing the LED cathodes on one ground trace (now possible since the
board carries real copper connections) cuts the board's breakout down to
3 nets total, rather than one pair per LED.

## Wiring notes

- **GND can be shared.** Both LEDs' cathodes (tied together on the board
  via a shared ground trace), one of the pot's outer legs, and the
  MCP3008's GND pin can all run to Pi GND pins — there are several on the
  40-pin header, so nothing needs tracing back to one single shared point
  off-board.
- **Pot wiring**: cable from the pot's 3 legs (two outer + wiper) plugs
  into the MCP3008 board's 3-pin JST header, **not the Pi directly** —
  one outer leg to 3.3V, the other to GND (making it a voltage divider),
  the wiper into one of the MCP3008's analog input channels via the
  board's own trace.
- **MCP3008 wiring**: on its board, the socket's pins are wired to two
  JST-XH male headers — the 3-pin one facing the pot (above) and a 6-pin
  one facing the Pi: standard SPI (MOSI, MISO, SCLK, one CS/CE pin) plus
  the chip's own power (3.3V) and GND, all otherwise free on this build
  (SPI isn't used elsewhere on the header).
- **Bare female Dupont pins are exposed metal** until seated on the
  header, same caveat as any Dupont jumper — connect/disconnect with the
  Pi powered off.
- **LED + resistor wiring is now entirely on-board solder joints** — each
  LED's anode through its resistor to a signal pad, both cathodes to the
  shared ground trace, standard through-hole soldering. Nothing to crimp
  or splice for the LEDs themselves.
- Signal path end to end for each LED: **GPIO pin → female Dupont → wire
  → JST-XH female housing → JST-XH male header (soldered to the LED
  board) → board trace → resistor → LED leg** (all soldered from the
  header onward).
- Signal path end to end for the volume reading: **pot leg → JST-XH
  female housing → JST-XH male header (soldered to the MCP3008 board,
  pot side) → board trace → DIP socket pin → MCP3008 chip → DIP socket
  pin → board trace → JST-XH male header (Pi side) → JST-XH female
  housing → wire → female Dupont → Pi SPI/power pin.**

## Mounting

- **LEDs**: fixed to the perma-proto board by their own soldered leads —
  no separate mounting hardware, the board is the panel position.
- **Potentiometer**: not on either board — it's panel-mounted on its
  own. Most pots (including detented ones) have the same threaded metal
  bushing around the shaft that a rotary encoder does; drill one round
  hole in the case at the shaft's diameter, push the bushing through
  from behind, and secure with the nut (and lock washer, if supplied)
  from the front. Check the panel's wall thickness against the bushing's
  threaded length before drilling; a thick wall can leave too little
  thread proud for the nut.
- **MCP3008 board**: no panel-facing part of its own, so it doesn't need
  drilling or a bushing — it just needs somewhere to sit (screwed down,
  stood off, or simply tucked out of the way) with a short cable run
  back to the pot, so it's naturally sited near the pot rather than at
  the LED board's location or back at the Pi.
- Each of the three assemblies here (LED board, pot, MCP3008 board) gets
  its own independent cable run — JST-XH crimped onto pins, wire run to
  wherever it's routed, female Dupont at the Pi-header end — same
  technique throughout, just not sharing a connector or a run between
  them.

## Open questions

- Exact GPIO pin assignments (BCM numbers for the two LEDs, the MCP3008's
  SPI pins, and any standalone button — see below) — not yet chosen; do
  this once the WM8960 HAT's pass-through header pinout is checked
  against what's already spoken for (see `satellite-hardware.md`'s
  WM8960 section). The WM8960 HAT reserves 8 pins: I2S audio
  (GPIO18/19/20/21), I2C1 codec control (GPIO2/3), and the HAT ID EEPROM
  (GPIO0/1, reserved on every HAT-format board regardless of which one).
  Plenty of the remaining 18 GPIO-capable header pins are free for this
  board's needs.
- **Open: is a mute/shutdown button still wanted at all, now that the
  volume control is a plain pot?** The rotary encoder this replaces had
  a built-in push-button (SW) that would have hosted mute or shutdown for
  free; a plain pot has no such leg, so either function now needs its
  own **standalone momentary switch** as a separate part, or gets dropped
  for this model. Not decided — revisit once the pot/MCP3008 swap above
  is confirmed as the final approach.
  - If a shutdown button is still wanted: `dtoverlay=gpio-shutdown`'s
    "press again to power back on" behaviour is hardwired to GPIO3
    specifically, but GPIO3 is exactly the pin the WM8960 HAT's I2C1
    uses for codec control (see above) — the two would conflict if
    double-purposed. So shutdown-with-button-wake isn't cleanly available
    on this hardware; a shutdown button would have to be software-only
    (clean halt via a watcher script on any free GPIO, but then booting
    again means physically unplugging and replugging power, no
    button-press wake). Mute has no such constraint and can go on any
    free pin.
  - **Future alternative, not needed now**: a dedicated power-control
    add-on (e.g. Pimoroni OnOff SHIM) would give real shutdown-with-wake
    without touching GPIO3 at all — these switch the actual 5V rail via
    their own latching circuit, so they work off any GPIO pin regardless
    of what the WM8960 HAT is doing on I2C1. The cost is physical
    stacking: the WM8960 HAT already occupies the 40-pin header, so this
    would need a GPIO extension/stacking header to fit both boards.
    Worth revisiting if shutdown-with-wake turns out to matter enough in
    practice to justify the extra part and stacking complexity.
- Software side: how the LEDs get driven (which states light which LED)
  and how the pot's ADC reading maps to a volume change (including the
  log-curve mapping noted in Scope above) — not designed yet, next topic.
- PTT, when it's added in the next model: since the volume control no
  longer carries a built-in button, PTT now needs its own standalone
  switch regardless — same open part as the mute/shutdown question above,
  worth deciding together rather than separately.
