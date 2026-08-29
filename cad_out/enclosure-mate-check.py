"""Mate check: lid seated on box at full engagement -> intersection must be ~0."""
import sys
sys.path.insert(0, r"C:\Users\Oz\.claude\skills\text-to-cad")
from build123d import *

box = import_step(r"C:\AI Stuff\Claude\ScrewPentair\cad_out\pool-enclosure-box.step")
lid = import_step(r"C:\AI Stuff\Claude\ScrewPentair\cad_out\pool-enclosure-lid.step")

# Assemble: flip the lid over (Rot X=180), then seat its plate on the box rim.
# Model lid: plate z=0..2.5, skirt to z=10.5. After flip: z -> -z (plate -2.5..0).
# Seat: plate underside on rim (box z=44.5) -> translate +47.0.
seated = Pos(0, 0, 47.0) * Rot(X=180) * lid

inter = box.intersect(seated)
vol = 0.0 if inter is None else sum(s.volume for s in inter.solids()) if inter.solids() else inter.volume
print(f"intersection volume: {vol:.4f} mm3")

def vol_of(shape):
    if shape is None:
        return 0.0
    try:
        return sum(s.volume for s in shape.solids())
    except Exception:
        return getattr(shape, "volume", 0.0)

# sanity: bump tips must sit inside the window openings (void), i.e. within
# X 50..52.5 at Z 39.5 +/- and Y +/-50 -> probe with a small box at that spot
probe = Pos(51.0, 50.0, 39.5) * Box(1.6, 10.0, 2.0)
bvol = vol_of(box.intersect(probe))
lvol = vol_of(seated.intersect(probe))
print(f"probe at window: box material {bvol:.3f} mm3 (want 0 = open window), "
      f"lid bump {lvol:.3f} mm3 (want >0 = bump present)")

ok = vol < 1.0 and bvol < 0.01 and lvol > 1.0
print("MATE_OK" if ok else "MATE_FAIL")
sys.exit(0 if ok else 1)
