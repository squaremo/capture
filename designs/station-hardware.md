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
- **Volume control** — a rotary encoder, not a potentiometer. The Pi's
  GPIO has no analog input, so a plain pot would need an ADC (e.g.
  MCP3008) in between; a rotary encoder reads digitally on two GPIO pins
  with no extra chip. Trade-off accepted: an encoder is "turn to change,
  no hard stops," not a knob whose physical position maps to a volume
  percentage — revisit if that distinction turns out to matter in use.

## Build approach

Soldering is now in scope for the LEDs and their resistors only —
everything from the board's edge onward (the cable to the Pi, and the
encoder, which is a separate breakout module rather than a board-mounted
part) stays crimp-only, no solder.

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
3. **JST-XH connectors for the encoder** — the encoder is a separate
   breakout module (KY-040), not mounted on this board, so it keeps the
   original crimped-JST-XH-onto-its-pins wiring rather than being
   soldered to anything.
4. **Female Dupont crimp terminals at the Pi end** — pushed directly onto
   the Pi's 40-pin GPIO header pins, for both the LED cable and the
   encoder cable. This removes the need for a separate GPIO breakout HAT:
   the header pins are standard 0.1"/2.54mm, the same pitch Dupont
   terminals are made for.

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
| 5 | Rotary encoder module | KY-040 (breakout, has built-in pull-ups) | 1 | volume control — see Scope above for why an encoder, not a pot; not board-mounted, wired independently |
| 6 | Perma-proto / stripboard | ~half-size, 0.1" pitch | 1 | now a real soldered circuit for the two LEDs, not just a mounting jig |
| 7 | JST-XH male header, PCB-mount/through-hole | 3-pin (white signal, red signal, shared GND) | 1 | soldered onto the board — the one other solder job, gives a plug/unplug point for the cable |
| 8 | JST-XH housings + crimp pins | 3-pin ×1 (matches the board header, item 7), 3-pin ×1 (encoder CLK/DT/common, if its own push-button isn't wired up this model) | 2 housings, 6 pins | a small assorted JST-XH kit (2/3/4-pin housings + pins) covers this |
| 9 | Female Dupont crimp terminals + housings | 2.54mm pitch, single-row | ~6 (one per signal; GND legs can share a Pi GND pin instead of needing separate terminals) | pushes directly onto the Pi GPIO header; replaces a breakout HAT entirely |
| 10 | Crimp tool | handles both Dupont (2.54mm) and JST-XH pitch | 1 | confirm both-pitch support before buying |
| 11 | Hookup wire | 22–26AWG, a few colours | short lengths | cable-side legs only — no wire needed on the board itself beyond the soldered leads/traces |
| 12 | Solder + iron | fine 0.6–0.8mm solder | — | only for items 1–4 + 7 — a handful of simple through-hole joints, not a full board's worth |

Sharing the LED cathodes on one ground trace (now possible since the
board carries real copper connections) cuts the board's breakout down to
3 nets total, rather than one pair per LED.

## Wiring notes

- **GND can be shared.** Both LEDs' cathodes (tied together on the board
  via a shared ground trace) and the encoder's GND leg can all run to Pi
  GND pins — there are several on the 40-pin header, so nothing needs
  tracing back to one single shared point off-board.
- **Bare female Dupont pins are exposed metal** until seated on the
  header, same caveat as any Dupont jumper — connect/disconnect with the
  Pi powered off.
- **LED + resistor wiring is now entirely on-board solder joints** — each
  LED's anode through its resistor to a signal pad, both cathodes to the
  shared ground trace, standard through-hole soldering. Nothing to crimp
  or splice for the LEDs themselves.
- Signal path end to end for each LED: **GPIO pin → female Dupont → wire
  → JST-XH female housing → JST-XH male header (soldered to the board) →
  board trace → resistor → LED leg** (all soldered from the header
  onward). The encoder's three signal legs (CLK/DT/common) are unrelated
  to the board — straight from their own JST-XH pin to the encoder's
  pins, as before.

## Mounting

- **LEDs**: fixed to the perma-proto board by their own soldered leads —
  no separate mounting hardware, the board is the panel position.
- **Rotary encoder**: not on the board — it isn't near the LEDs, and
  mounts itself the same way a potentiometer does. The encoder body has
  a threaded metal bushing around the shaft; drill one round hole in the
  case at the shaft's diameter, push the bushing through from behind, and
  secure with the nut (and lock washer, if supplied) from the front. The
  small breakout PCB (the 5-pin part) needs no fixing of its own — it
  hangs rigidly off the back of the panel-mounted body. Check the panel's
  wall thickness against the bushing's threaded length before drilling;
  a thick wall can leave too little thread proud for the nut.
- Being a separate location from the LED board, the encoder gets its own
  independent cable — JST-XH crimped onto its pins, wire run to wherever
  it's routed, female Dupont at the Pi-header end — same technique as the
  LED cable, just not sharing a connector or a run with it.

## Open questions

- Exact GPIO pin assignments (BCM numbers for the two LEDs and the
  encoder's CLK/DT) — not yet chosen; do this once the WM8960 HAT's
  pass-through header pinout is checked against what's already spoken
  for (see `satellite-hardware.md`'s WM8960 section).
- Software side: how the LEDs get driven (which states light which LED)
  and how encoder turns map to a volume change — not designed yet, next
  topic.
- PTT, when it's added in the next model: whether it reuses the
  encoder's own push-button (already present on the KY-040, just unwired
  this round) or a standalone switch.
