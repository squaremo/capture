# Station control board: indicators + volume, solderless

Status: BOM decided, not yet built. Refines the "Custom control board"
section of `designs/satellite-hardware.md` (indicator lights + volume +
PTT, planned there but undesigned) — this doc is that design. Read
`satellite-hardware.md` first for how this board fits into the kiosk box
as a whole (case, screen, WM8960 audio HAT, GPIO header availability).

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

## Build approach: solderless, no solder station available

No part of this build is soldered. Three techniques cover it:

1. **Perma-proto/stripboard as a mechanical mounting jig only** — a
   plated prototyping board is used purely to hold the LEDs and encoder
   at fixed panel positions (useful for a wall-mounted front panel). Its
   copper pads are **not** relied on for electrical connection — without
   solder, pushed-through leads only make friction contact, which isn't
   reliable for anything that gets moved or lives long-term in an
   enclosure. All real electrical paths run through crimped connectors
   instead (next two points).
2. **JST-XH connectors at the board end** — crimped onto each
   component's leads, locking (unlike Dupont, which pulls apart), used
   for the LED and encoder wiring on the board side.
3. **Female Dupont crimp terminals at the Pi end** — pushed directly onto
   the Pi's 40-pin GPIO header pins. This removes the need for a separate
   GPIO breakout HAT: the header pins are standard 0.1"/2.54mm, the same
   pitch Dupont terminals are made for.

One crimp tool that handles both 2.54mm Dupont and JST-XH pitch covers
both ends of every wire (confirm before buying — most small ratcheting
"SN-28B"-style crimpers do, but not all).

## BOM

| # | Item | Spec | Qty | Notes |
|---|------|------|-----|-------|
| 1 | White LED | 5mm, standby/on indicator | 1 | |
| 2 | Red LED | 5mm, live-mic indicator | 1 | |
| 3 | Resistor, LED (white) | ~330Ω, 1/4W | 1 | inline on the wire, GPIO is 3.3V logic |
| 4 | Resistor, LED (red) | ~220–330Ω, 1/4W | 1 | red LEDs often want less than white — check the LED's datasheet Vf if available |
| 5 | Rotary encoder module | KY-040 (breakout, has built-in pull-ups) | 1 | volume control — see Scope above for why an encoder, not a pot |
| 6 | Perma-proto / stripboard | ~half-size, 0.1" pitch | 1 | mounting jig only, no electrical role |
| 7 | JST-XH housings + crimp pins | 2-pin ×2 (LEDs), 3-pin ×1 (encoder CLK/DT/common, if the encoder's own push-button isn't wired up this model) | 3 housings, ~7 pins | a small assorted JST-XH kit (2/3/4-pin housings + pins) covers this without buying sizes separately |
| 8 | Female Dupont crimp terminals + housings | 2.54mm pitch, single-row | ~7 (one per signal, GND legs can share a Pi GND pin instead of needing separate terminals) | pushes directly onto the Pi GPIO header; replaces a breakout HAT entirely |
| 9 | Crimp tool | handles both Dupont (2.54mm) and JST-XH pitch | 1 | confirm both-pitch support before buying |
| 10 | Hookup wire | 22–26AWG, a few colours | short lengths | board-side and header-side legs |

Connector/pin count assumes the encoder's own click-button is left
unwired this model (PTT is deferred anyway, and the encoder's button
isn't needed for volume alone) — 3 signals per LED-or-encoder-leg group,
9 total, comfortably inside one small assorted crimp kit.

## Wiring notes

- **GND can be shared.** Both LEDs' cathodes and the encoder's GND leg
  can run to Pi GND pins — there are several on the 40-pin header, so
  each doesn't need tracing back to one single shared point.
- **Bare female Dupont pins are exposed metal** until seated on the
  header, same caveat as any Dupont jumper — connect/disconnect with the
  Pi powered off.
- **LED series resistors have no solder joint to anchor them** — since
  nothing here is soldered, keep the resistor in-line inside the wire run
  (twisted/crimped into the same lead as the LED, not just resting in a
  board hole) so it can't work loose.
- Signal path end to end: **GPIO pin → female Dupont → wire (± inline
  resistor for the LEDs) → JST-XH → LED/encoder leg.**

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
