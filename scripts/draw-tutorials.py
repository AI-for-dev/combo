"""The twelve illustrations of docs/tutorials, drawn from one vocabulary.

Documents are what an agent reads, a bracket is an agent (the logo's own shape), the
terminal is the reader's session, and the one verdigris line is what comes back. Grey
for what is read, verdigris for who acts and what they return. No text, so no font; one
file per drawing, legible on the light and the dark ground alike, which is why the grey
is the mid ink-3 and the verdigris sits between the light and the dark accent.

    python3 scripts/draw-tutorials.py docs/_static/tutorials
"""
import sys
G="#7E8894"; V="#2F958A"
W,H=640,220

def head(label): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{label}">\n  <title>{label}</title>\n'
def rect(x,y,w,h,fill=G,op=1,rx=0):
    o=f' fill-opacity="{op}"' if op!=1 else ""; r=f' rx="{rx}"' if rx else ""
    return f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"{o}{r} />\n'
def stroke(d,color=G,w=2,op=1,dash=None):
    o=f' stroke-opacity="{op}"' if op!=1 else ""; da=f' stroke-dasharray="{dash}"' if dash else ""
    return f'  <path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"{o}{da} />\n'
def doc(x,y,s=1,op=.7,lines=3):
    w,h,f=22*s,28*s,7*s
    out=stroke(f"M{x} {y} H{x+w-f} L{x+w} {y+f} V{y+h} H{x} Z",w=1.6,op=op)
    out+=stroke(f"M{x+w-f} {y} V{y+f} H{x+w}",w=1.6,op=op)
    for i in range(lines):
        out+=rect(x+5*s,y+12*s+i*5*s,(w-10*s)*(1 if i%2==0 else .7),1.8*s,op=op*.8)
    return out
def docgrid(x0,y0,cols,rows,gap=8,s=1,op=.7):
    return "".join(doc(x0+c*(22*s+gap),y0+r*(28*s+gap),s=s,op=op if (r+c)%2 else op*.75) for r in range(rows) for c in range(cols))
def bracket(x,y,h,w=30,t=14,color=V,mirror=False,op=1,dash=None):
    """The agent: the logo's bracket. `mirror` turns it to face left."""
    if dash:
        d=f"M{x+w} {y} H{x} V{y+h} H{x+w}" if not mirror else f"M{x} {y} H{x+w} V{y+h} H{x}"
        return stroke(d,color=color,w=t*.6,op=op,dash=dash)
    a=t*.55
    if not mirror: d=f"M{x} {y} H{x+w} V{y+t} H{x+a} V{y+h-t} H{x+w} V{y+h} H{x} Z"
    else: d=f"M{x+w} {y} H{x} V{y+t} H{x+w-a} V{y+h-t} H{x} V{y+h} H{x+w} Z"
    o=f' fill-opacity="{op}"' if op!=1 else ""
    return f'  <path fill="{color}"{o} d="{d}" />\n'
def terminal(x,y,w,h,op=.8):
    out=stroke(f"M{x} {y} H{x+w} V{y+h} H{x} Z",w=2,op=op)+stroke(f"M{x} {y+16} H{x+w}",w=1.5,op=op*.6)
    out+="".join(f'  <circle cx="{x+10+i*10}" cy="{y+8}" r="2.4" fill="{G}" fill-opacity="{op*.7}" />\n' for i in range(3))
    return out
def chevron(x,y,color=G,op=.8): return stroke(f"M{x} {y} l6 6 l-6 6",color=color,w=2.2,op=op)
def arrow(x1,y1,x2,y2,color=V,w=3,dash=None):
    out=stroke(f"M{x1} {y1} L{x2} {y2}",color=color,w=w,dash=dash)
    import math
    a=math.atan2(y2-y1,x2-x1); s=9
    p1=(x2-s*math.cos(a-.5),y2-s*math.sin(a-.5)); p2=(x2-s*math.cos(a+.5),y2-s*math.sin(a+.5))
    return out+stroke(f"M{p1[0]:.1f} {p1[1]:.1f} L{x2} {y2} L{p2[0]:.1f} {p2[1]:.1f}",color=color,w=w)
def check(x,y,s=1,color=V,w=4): return stroke(f"M{x} {y+8*s} l{7*s} {7*s} l{14*s} -{16*s}",color=color,w=w)
def cross(x,y,s=10,color=V,w=4): return stroke(f"M{x-s} {y-s} L{x+s} {y+s} M{x+s} {y-s} L{x-s} {y+s}",color=color,w=w)
def gauge(x,y,w,h,level,color=V,op=.8):
    return stroke(f"M{x} {y} H{x+w} V{y+h} H{x} Z",w=2,op=op)+rect(x,y+h-h*level,w,h*level,fill=color)
def term_result(x,y,w,h,line_w=150,line_op=1,second=True):
    out=terminal(x,y,w,h)+chevron(x+18,y+36)+rect(x+34,y+40,line_w,6,fill=V,op=line_op)
    if second: out+=chevron(x+18,y+66,op=.35)
    return out

D={}

# 01 - H, as chosen.
s=head("Twenty documents held by a bracket, one line in a terminal")
s+=docgrid(36,36,4,4)+bracket(180,30,160)+arrow(222,110,334,110)+term_result(360,44,240,132)
D["01-one-scout"]=s

# 02 - three brackets, each over its own documents, into one bracket, into the terminal.
s=head("Three brackets over three piles of documents, one bracket gathering them, one line in a terminal")
for i,y in enumerate((22,84,146)):
    s+=docgrid(36,y,2,1,gap=6,s=.85,op=.7)+doc(36+2*(22*.85+6)+0,y,s=.85,op=.55)
    s+=bracket(130,y-2,28,w=20,t=9)
    s+=stroke(f"M158 {y+12} H200 L226 110",color=V,w=2.5)
s+=bracket(230,60,100)+arrow(272,110,334,110)+term_result(360,44,240,132)
D["02-three-scouts"]=s

# 03 - a chain of brackets passing a line along, under a terminal that stays empty; one
# dashed arrow up is the quote.
s=head("A chain of brackets passing a line along, below an empty terminal, one dashed arrow up")
s+=term_result(200,20,400,96,line_w=0,second=False)
s=s.replace(rect(234,60,0,6,fill=V),"")  # no line: the session knows nothing
xs=(40,220,400)
for i,x in enumerate(xs):
    s+=bracket(x,146,60,w=22,t=10)
    s+=rect(x+34,171,90,6,fill=G,op=.55 if i<2 else 1)
    if i<2: s+=arrow(x+130,174,x+170,174,color=G,w=2)
s+=arrow(540,168,540,122,dash="5 5")
D["03-keep-the-session-out"]=s

# 04 - a big document whose lines are the chain: brackets and arrows drawn on the page,
# and the same chain running to its right.
s=head("A document with a chain of brackets drawn on it, and the same chain running beside it")
s+=stroke("M40 30 H190 L220 60 V190 H40 Z",w=2.2,op=.8)+stroke("M190 30 V60 H220",w=2.2,op=.8)
s+=stroke("M60 80 H140",w=2,op=.5)
for i,y in enumerate((100,124,148)):
    s+=bracket(62,y-8,16,w=10,t=5,color=G,op=.7)+rect(80,y-2,60 if i%2==0 else 40,4,op=.5)
s+=arrow(240,110,290,110)
for i,x in enumerate((300,400,500)):
    s+=bracket(x,76,68,w=22,t=10)
    if i<2: s+=arrow(x+36,110,x+92,110,color=G,w=2)
s+=rect(536,107,64,6,fill=V)
D["04-write-it-down"]=s

# 05 - one way: the documents flow into the bracket, the arrow back towards them is
# crossed out. It reads; it cannot write; the report still reaches the terminal.
s=head("Documents flowing into a bracket, the arrow back to them crossed out, one line in a terminal")
s+=docgrid(36,36,4,4)
s+=arrow(150,78,198,78,color=G,w=4)
s+=stroke("M198 142 H150",color=G,w=4,op=.6)+stroke("M160 132 L150 142 L160 152",color=G,w=4,op=.6)
s+=cross(174,142,s=12,w=5)
s+=bracket(206,30,160)+arrow(248,110,334,110)+term_result(360,44,240,132)
D["05-an-agent-that-cannot-write"]=s

# 06 - the bracket holds a card of checked boxes before the documents: the rule first.
s=head("A bracket holding a checklist card and documents, one line in a terminal")
s+=stroke("M36 40 H150 V180 H36 Z",color=V,w=2.5)
for i,y in enumerate((64,100,136)):
    s+=stroke(f"M52 {y} H66 V{y+14} H52 Z",color=V,w=2)+check(53,y-2,s=.5,w=2.5)+rect(76,y+5,54 if i%2==0 else 40,4,fill=V,op=.6)
s+=docgrid(170,50,2,3,gap=8,op=.7)
s+=bracket(240,30,160)+arrow(282,110,334,110)+term_result(360,44,240,132)
D["06-teach-it-a-rule"]=s

# 07 - two brackets facing each other, lines bouncing between them, a check at the end.
s=head("Two brackets facing each other, lines going back and forth, a check mark at the end")
s+=bracket(60,40,140)+bracket(300,40,140,mirror=True)
for i,y in enumerate((70,100,130)):
    if i%2==0: s+=arrow(104,y,286,y,color=G,w=2.5)
    else: s+=arrow(286,y,104,y,color=G,w=2.5)
s+=arrow(104,160,286,160,color=V,w=3)
s+=check(380,96,s=1.4,w=5)
s+=term_result(440,44,160,132,line_w=90)
D["07-until-lgtm"]=s

# 08 - the pair, then a box with a check running, then a commit dot on a branch line.
s=head("Two brackets, then a box with a check mark, then a dot on a branch line")
s+=bracket(36,60,100,w=24,t=11)+bracket(120,60,100,mirror=True,w=24,t=11)
s+=arrow(150,110,200,110)
s+=stroke("M210 70 H310 V150 H210 Z",w=2.5,op=.8)+check(238,98,s=1.2,w=4.5)
s+=arrow(320,110,380,110)
s+=stroke("M400 110 H600",w=3,op=.6)
s+=f'  <circle cx="470" cy="110" r="10" fill="{G}" fill-opacity=".6" />\n'
s+=f'  <circle cx="540" cy="110" r="12" fill="{V}" />\n'
D["08-build"]=s

# 09 - two brackets each in a dashed copy, merging one after the other onto one line.
s=head("Two brackets in two dashed boxes, two branches merging one after the other into one line")
s+=stroke("M40 190 H600",w=3,op=.6)
for i,(x,y) in enumerate(((60,30),(280,30))):
    s+=stroke(f"M{x} {y} H{x+150} V{y+100} H{x} Z",w=2,op=.6,dash="6 6")
    s+=docgrid(x+14,y+18,2,2,gap=6,s=.75,op=.7)
    s+=bracket(x+96,y+18,64,w=22,t=10)
    s+=stroke(f"M{x+75} {y+100} V150 L{x+75+70} 190",color=V,w=3)
    s+=f'  <circle cx="{x+75+70}" cy="190" r="8" fill="{V}" />\n'
s+=check(520,150,s=1.2,w=4.5)
D["09-two-coders-one-tree"]=s

# 10 - a bracket over a pile that overflows, a gauge nearly full, and a cross that stops it.
s=head("A bracket over an overflowing pile of documents, a gauge nearly full, a cross")
for r in range(6):
    for c in range(5):
        s+=doc(36+c*26,10+r*32,s=.85,op=.35 if r>3 else .6)
s+=bracket(176,30,160)
s+=gauge(250,30,40,160,.92)
s+=cross(360,110,s=22,w=7)
s+=term_result(420,44,180,132,line_w=0,second=False)
D["10-the-meter"]=s

# 11 - the same bracket and documents twice, two bills of different lengths.
s=head("The same bracket over the same documents twice, two horizontal bars of different lengths")
for i,y in enumerate((26,120)):
    s+=docgrid(36,y+6,3,2,gap=6,s=.85,op=.7)
    s+=bracket(140,y,70,w=22,t=10,op=1 if i==0 else .55)
    s+=arrow(176,y+35,220,y+35)
    s+=rect(236,y+30,300 if i==0 else 90,10,fill=G,op=.6)
    s+=rect(236,y+46,150 if i==0 else 150,6,fill=V)
D["11-two-models"]=s

# 12 - a big bracket holding three small brackets, each over documents.
s=head("A large bracket holding three smaller brackets, each over documents, one line in a terminal")
for i,y in enumerate((30,92,154)):
    s+=docgrid(120,y+2,2,1,gap=6,s=.85,op=.7)
    s+=bracket(186,y,36,w=20,t=9,op=.8)
s+=bracket(46,22,176,w=36,t=16)
s+=arrow(236,110,334,110)+term_result(360,44,240,132)
D["12-a-subagent-with-subagents"]=s

out=sys.argv[1]
for name,svg in D.items():
    open(f"{out}/{name}.svg","w").write(svg+"</svg>\n")
print(len(D),"drawings")
