# Peg layout utility

This one-off utility marks cross-lawn bands on the saved **Rear Lawn**. It uses
Pattern A's 23-degree long axis, the production-shaped lawn perimeter, all saved
obstacles (currently **Obstacle 1** and **Trampolene**), and the configured mowing
standoff. It does not assume that the lawn is 23 metres wide: each divider is
placed where the accumulated usable lawn area reaches approximately 83.25 m².

The top and bottom cross-lines and their left/right endpoints are inset by the
configured mowing standoff (currently 15 cm). Band areas are still calculated
from the shaped lawn and exclusions; the inset gives the mower control point a
safe working margin. A final smaller remainder band is included rather than
being silently discarded.

## Preview first

From `/home/mower/mower` on the mower, after the production build is current:

```sh
npm run measure:peg-layout
```

Preview is read-only. It prints every cross-lawn line's actual boundary width,
the peg-to-peg width after standoff, both GNSS-map endpoints, and each band's
depth and usable area. Check this table before allowing motion.

## Execute

Place the mower inside the Rear Lawn near the top of the app map, ensure the
Drive & Paths page and its STOP control remain available, then run:

```sh
npm run measure:peg-layout -- --execute
```

The runner requires the mower service to be running and the fused pose quality
to be trusted GNSS. It calculates a safe production transit from the live pose
to the upper-left first peg, drives there using the ordinary pivot-then-straight
segment controller, and pauses for 10 seconds. It then crosses to the right,
moves down on the right, crosses left, and continues alternating. The pause and
terminal bell occur at peg points only; any routing vertices needed to avoid an
obstacle or concave boundary are passed without a peg pause.

Press Ctrl-C in the terminal or STOP in Drive & Paths to stop. A failed drive,
unsafe route, loss of trusted GNSS, another active operation, or an unavailable
controller aborts the utility and requests the global emergency stop. Do not
start another mower operation while this utility is running.

Useful one-off overrides are available through `--help`, including target area,
heading, pause duration, standoff, edge inset, area name, and service URL.
