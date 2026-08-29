import sys
sys.path.insert(0, r"C:\Users\Oz\.claude\skills\text-to-cad")
from build123d import *
from cad_helpers import safe_cut, safe_fuse, safe_fillet, safe_chamfer, measure, finalize

# --- Parameters (interior dims per user; all mm) ---
WALL = 2.5
IN_W = 100.0          # interior width  (X)
IN_H = 150.0          # interior height (Y)
IN_D = 42.0           # interior depth  (Z)
OUT_W = IN_W + 2 * WALL          # 105.0
OUT_H = IN_H + 2 * WALL          # 155.0
OUT_D = IN_D + WALL              # 44.5 (back closed, front open)

PIPE_DIA = 21.0
PIPE_EDGE_FROM_BACK = 10.0       # hole's near edge to the box's back exterior face
PIPE_Z = PIPE_EDGE_FROM_BACK + PIPE_DIA / 2   # 10 + 10.5 = 20.5

SLOT_W = 6.5                     # X
SLOT_H = 42.0                    # Y
SLOT_SPACING = 57.5              # center-to-center
SLOT_X = SLOT_SPACING / 2        # 28.75
FLOOR_Y = -OUT_H / 2 + WALL      # -77.5 + 2.5 = -75.0 (interior floor)
SLOT_CY = FLOOR_Y + 5.0 + SLOT_H / 2   # -75 + 5 + 21 = -49.0

WIN_LEN = 14.0                   # snap window length (Y)
WIN_HT = 3.2                     # snap window height (Z)
WIN_Y = 50.0                     # window centers at Y = +/-50
WIN_Z = OUT_D - 5.0              # 39.5 (5mm below front rim)
SIDE_X = IN_W / 2 + WALL / 2     # 51.25 (center of side wall thickness)

CORNER_R = 4.0

# --- Build: additive ---
body = Box(OUT_W, OUT_H, OUT_D, align=(Align.CENTER, Align.CENTER, Align.MIN))
measure(body, "outer-shell", "outer")

# --- Subtractive ---
# main cavity (open front): overshoots 2mm past the rim
cavity = Pos(0, 0, WALL) * Box(IN_W, IN_H, IN_D + 2.0,
                               align=(Align.CENTER, Align.CENTER, Align.MIN))
body = safe_cut(body, cavity, "cavity")

# pipe hole through bottom wall (axis along Y); wall spans Y -77.5..-75.0
pipe = Pos(0, -OUT_H / 2 + WALL / 2, PIPE_Z) * Rot(X=90) * \
    Cylinder(radius=PIPE_DIA / 2, height=WALL + 4.0)
body = safe_cut(body, pipe, "pipe-hole")

# two vertical mounting slots through the back plate (Z 0..2.5)
slot_r = Pos(SLOT_X, SLOT_CY, -2.0) * Box(SLOT_W, SLOT_H, WALL + 4.0,
                                          align=(Align.CENTER, Align.CENTER, Align.MIN))
body = safe_cut(body, slot_r, "slot-right")
slot_l = mirror(slot_r, about=Plane.YZ)
body = safe_cut(body, slot_l, "slot-left")

# four snap windows through the side walls (X = +/-52.5 walls)
win_rf = Pos(SIDE_X, WIN_Y, WIN_Z) * Box(WALL + 4.0, WIN_LEN, WIN_HT)
win_rb = Pos(SIDE_X, -WIN_Y, WIN_Z) * Box(WALL + 4.0, WIN_LEN, WIN_HT)
body = safe_cut(body, win_rf, "window-right-top")
body = safe_cut(body, win_rb, "window-right-bottom")
body = safe_cut(body, mirror(win_rf, about=Plane.YZ), "window-left-top")
body = safe_cut(body, mirror(win_rb, about=Plane.YZ), "window-left-bottom")

# --- Finishing ---
# round the four full-depth outer corner edges
z_edges = body.edges().filter_by(Axis.Z)
corners = [e for e in z_edges
           if abs(e.center().X) > IN_W / 2 and abs(e.center().Y) > IN_H / 2
           and e.length > OUT_D - 1]
body = safe_fillet(body, corners, CORNER_R, "outer-corners")

if __name__ == "__main__":
    finalize(body, "pool-enclosure-box", out_dir=r"cad_out")
