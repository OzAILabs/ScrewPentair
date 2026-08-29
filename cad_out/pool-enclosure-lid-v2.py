import sys
sys.path.insert(0, r"C:\Users\Oz\.claude\skills\text-to-cad-color")
from build123d import *
from cad_helpers import safe_cut, safe_fuse, safe_fillet, safe_chamfer, measure, finalize_parts

# --- Lid geometry (identical to pool-enclosure-lid v1) ---
WALL = 2.5
OUT_W = 105.0
OUT_H = 155.0
PLATE_T = 2.5
CLEAR = 0.2
SKIRT_OW = 100.0 - 2 * CLEAR
SKIRT_OH = 150.0 - 2 * CLEAR
SKIRT_T = 2.0
SKIRT_DEPTH = 8.0
SKIRT_EMBED = 1.0
BUMP_R = 1.2
BUMP_LEN = 12.0
BUMP_Y = 50.0
BUMP_Z = PLATE_T + 5.0
BUMP_X = SKIRT_OW / 2
CORNER_R = 4.0

# --- Artwork (outside face = z0, printed on the bed -> mirror X) ---
INLAY_D = 0.6                    # 3 layers at 0.2mm
PI_SIZE = 62.0                   # ~44mm tall glyph
PI_Y = 38.0
WORD = "SCREWLOGIC"
WORD_SIZE = 12.0
WORD_Y = -10.0
TAG1 = "PROTOCOL ADAPTER"
TAG2 = "$1,160 CHEAPER"
TAG_SIZE = 7.0
TAG1_Y = -28.0
TAG2_Y = -40.0

# --- Build the white lid (single solid) ---
body = Box(OUT_W, OUT_H, PLATE_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
skirt = Pos(0, 0, PLATE_T - SKIRT_EMBED) * \
    Box(SKIRT_OW, SKIRT_OH, SKIRT_DEPTH + SKIRT_EMBED,
        align=(Align.CENTER, Align.CENTER, Align.MIN))
body = safe_fuse(body, skirt, "skirt")
skirt_hollow = Pos(0, 0, PLATE_T) * \
    Box(SKIRT_OW - 2 * SKIRT_T, SKIRT_OH - 2 * SKIRT_T, SKIRT_DEPTH + 4.0,
        align=(Align.CENTER, Align.CENTER, Align.MIN))
body = safe_cut(body, skirt_hollow, "skirt-hollow")

bump_rt = Pos(BUMP_X, BUMP_Y, BUMP_Z) * Rot(X=90) * Cylinder(radius=BUMP_R, height=BUMP_LEN)
bump_rb = Pos(BUMP_X, -BUMP_Y, BUMP_Z) * Rot(X=90) * Cylinder(radius=BUMP_R, height=BUMP_LEN)
body = safe_fuse(body, bump_rt, "bump-right-top")
body = safe_fuse(body, bump_rb, "bump-right-bottom")
body = safe_fuse(body, mirror(bump_rt, about=Plane.YZ), "bump-left-top")
body = safe_fuse(body, mirror(bump_rb, about=Plane.YZ), "bump-left-bottom")

top_edges = [e for e in body.edges().filter_by(Plane.XY)
             if abs(e.center().Z - (PLATE_T + SKIRT_DEPTH)) < 0.01
             and (abs(e.center().X) > SKIRT_OW / 2 - SKIRT_T / 2
                  or abs(e.center().Y) > SKIRT_OH / 2 - SKIRT_T / 2)]
body = safe_chamfer(body, top_edges, 0.8, "skirt-leadin")
z_edges = body.edges().filter_by(Axis.Z)
corners = [e for e in z_edges
           if abs(e.center().X) > SKIRT_OW / 2 and abs(e.center().Y) > SKIRT_OH / 2]
body = safe_fillet(body, corners, CORNER_R, "plate-corners")

# --- Artwork sketches (drawn reading-correct, then mirrored for face-down print) ---
sk_pi = Pos(0, PI_Y) * Text("\u03c0", font_size=PI_SIZE, font="Arial",
                            font_style=FontStyle.BOLD)
sk_word = Pos(0, WORD_Y) * Text(WORD, font_size=WORD_SIZE, font="Arial Black")
sk_tag1 = Pos(0, TAG1_Y) * Text(TAG1, font_size=TAG_SIZE, font="Arial",
                                font_style=FontStyle.BOLD)
sk_tag2 = Pos(0, TAG2_Y) * Text(TAG2, font_size=TAG_SIZE, font="Arial",
                                font_style=FontStyle.BOLD)

def inlay(sk, label):
    region = mirror(extrude(sk, amount=INLAY_D), about=Plane.YZ)
    tool = mirror(Pos(0, 0, -1.0) * extrude(sk, amount=1.0 + INLAY_D + 0.0),
                  about=Plane.YZ)
    measure(region, label, "inlay")
    return region, tool

pi_region, pi_tool = inlay(sk_pi, "pi")
word_region, word_tool = inlay(sk_word, "wordmark")
tag1_region, tag1_tool = inlay(sk_tag1, "tag1")
tag2_region, tag2_tool = inlay(sk_tag2, "tag2")

body = safe_cut(body, pi_tool, "pocket-pi")
body = safe_cut(body, word_tool, "pocket-wordmark")
body = safe_cut(body, tag1_tool, "pocket-tag1")
body = safe_cut(body, tag2_tool, "pocket-tag2")

ink = word_region + tag1_region + tag2_region

if __name__ == "__main__":
    finalize_parts({
        "lid": (body, "#f5f5f0"),
        "pi":  (pi_region, "#e8641b"),
        "ink": (ink, "#1a1a1a"),
    }, "pool-enclosure-lid-v2", out_dir=r"cad_out")
