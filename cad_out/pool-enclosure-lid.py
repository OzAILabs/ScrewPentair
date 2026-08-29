import sys
sys.path.insert(0, r"C:\Users\Oz\.claude\skills\text-to-cad")
from build123d import *
from cad_helpers import safe_cut, safe_fuse, safe_fillet, safe_chamfer, measure, finalize

# --- Parameters (mates pool-enclosure-box; all mm) ---
WALL = 2.5
OUT_W = 105.0                    # matches box exterior
OUT_H = 155.0
PLATE_T = 2.5

CLEAR = 0.2                      # per-side skirt clearance in the 100x150 cavity
SKIRT_OW = 100.0 - 2 * CLEAR     # 99.6 skirt outline (X)
SKIRT_OH = 150.0 - 2 * CLEAR     # 149.6 skirt outline (Y)
SKIRT_T = 2.0
SKIRT_DEPTH = 8.0                # below plate inner face when installed
SKIRT_EMBED = 1.0                # sunk into the plate so the union overlaps

BUMP_R = 1.2
BUMP_LEN = 12.0
BUMP_Y = 50.0                    # matches box window centers
BUMP_Z = PLATE_T + 5.0           # 7.5: 5mm below plate inner face -> box window at rim-5
BUMP_X = SKIRT_OW / 2            # 49.8: ridge centered on skirt outer face

CORNER_R = 4.0                   # matches box corners

# --- Build: additive ---
body = Box(OUT_W, OUT_H, PLATE_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
measure(body, "plate", "plate")

skirt = Pos(0, 0, PLATE_T - SKIRT_EMBED) * \
    Box(SKIRT_OW, SKIRT_OH, SKIRT_DEPTH + SKIRT_EMBED,
        align=(Align.CENTER, Align.CENTER, Align.MIN))
measure(skirt, "skirt-blank", "skirt")
body = safe_fuse(body, skirt, "skirt")
skirt_hollow = Pos(0, 0, PLATE_T) * \
    Box(SKIRT_OW - 2 * SKIRT_T, SKIRT_OH - 2 * SKIRT_T, SKIRT_DEPTH + 4.0,
        align=(Align.CENTER, Align.CENTER, Align.MIN))
body = safe_cut(body, skirt_hollow, "skirt-hollow")

# four snap ridges: half-round beads on the skirt's outer X faces
bump_rt = Pos(BUMP_X, BUMP_Y, BUMP_Z) * Rot(X=90) * Cylinder(radius=BUMP_R, height=BUMP_LEN)
bump_rb = Pos(BUMP_X, -BUMP_Y, BUMP_Z) * Rot(X=90) * Cylinder(radius=BUMP_R, height=BUMP_LEN)
body = safe_fuse(body, bump_rt, "bump-right-top")
body = safe_fuse(body, bump_rb, "bump-right-bottom")
body = safe_fuse(body, mirror(bump_rt, about=Plane.YZ), "bump-left-top")
body = safe_fuse(body, mirror(bump_rb, about=Plane.YZ), "bump-left-bottom")

# --- Finishing ---
# lead-in chamfer on the skirt's top (insertion) rim — outer edges only
top_edges = [e for e in body.edges().filter_by(Plane.XY)
             if abs(e.center().Z - (PLATE_T + SKIRT_DEPTH)) < 0.01
             and (abs(e.center().X) > SKIRT_OW / 2 - SKIRT_T / 2
                  or abs(e.center().Y) > SKIRT_OH / 2 - SKIRT_T / 2)]
body = safe_chamfer(body, top_edges, 0.8, "skirt-leadin")

# round the plate's four corner edges to match the box
z_edges = body.edges().filter_by(Axis.Z)
corners = [e for e in z_edges
           if abs(e.center().X) > SKIRT_OW / 2 and abs(e.center().Y) > SKIRT_OH / 2]
body = safe_fillet(body, corners, CORNER_R, "plate-corners")

if __name__ == "__main__":
    finalize(body, "pool-enclosure-lid", out_dir=r"cad_out")
