"""End-to-end generate for N32.83296 S32.83196 W34.97741 E34.97857 (live network)."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from voxelworlds.pipeline import generate
from voxelworlds.protocol import Emitter, Job
class Sink:
    def __init__(s): s.ev=[]
    def write(s,l): s.ev.append(json.loads(l))
    def flush(s): pass
sink=Sink(); job=Job("t",Emitter(sink))
vs=float(sys.argv[1]) if len(sys.argv)>1 else 0.5
p=dict(bbox=dict(latMin=32.83196,latMax=32.83296,lonMin=34.97741,lonMax=34.97857),voxelSize=vs,
 metersPerFloor=3.0,defaultBuildingHeight=9.0,maxVoxels=50_000_000,features=dict(roads=True,elevation=True,mapillary=False),tileSize=500)
try: generate(job,p)
except Exception as e: print("EXC",type(e).__name__,getattr(e,"code",""),e)
for e in sink.ev:
    if e.get("type") in("result","error","warning"): print(json.dumps(e)[:400])
print("events",len(sink.ev))
