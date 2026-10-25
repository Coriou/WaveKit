"""Regenerates multimon-ax25-headers.txt: synthetic AX.25 frames (callsigns
N0CALL-3, APRS, WIDE1-1, WIDE2-2; every frame type and command/response and
poll/final combination) as AFSK1200 audio, decoded by a local multimon-ng.

Usage: python3 -I gen-multimon-ax25-headers.py <scratch-dir> [multimon-ng]
Prints one header line per frame; sort -u the output into the fixture.
"""
import math,struct,subprocess,sys
root=sys.argv[1]
binary=sys.argv[2] if len(sys.argv)>2 else 'multimon-ng'
def addr(call,ssid=0,last=False,high=False):
 return bytes([ord(c)<<1 for c in call.ljust(6)])+bytes([0x60|ssid<<1|int(last)|(128 if high else 0)])
def signal(frame):
 crc=65535
 for b in frame:
  crc^=b
  for _ in range(8): crc=(crc>>1)^(0x8408 if crc&1 else 0)
 frame+=struct.pack('<H',crc^65535)
 flag=[0,1,1,1,1,1,1,0];bits=flag*80;ones=0
 for b in frame:
  for k in range(8):
   v=(b>>k)&1;bits.append(v);ones=ones+1 if v else 0
   if ones==5: bits.append(0);ones=0
 bits+=flag*20
 s=[];ph=0;st=0;idx=0
 for i in range(int(len(bits)*22050/1200)):
  t=int(i*1200/22050)
  while idx<=t:
   if bits[idx]==0: st^=1
   idx+=1
  ph+=2*math.pi*(1200 if st else 2200)/22050
  s.append(int(20000*math.sin(ph)))
 return struct.pack('<'+'h'*len(s),*s)
ctrls={'I':0x10,'I_np':0x00,'Inr':0x52|0x10,'RR':0x71,'RR_np':0x61,'RNR':0x05|0x10,'REJ':0x09|0x10,'SREJ':0x0d,'SABME':0x6f,'SABMEp':0x7f,'SABM':0x3f,'DISC':0x53,'DM':0x1f,'UA':0x73,'FRMR':0x97,'UI':0x03,'UIp':0x13,'XID':0xbf,'TEST':0xf3}
for dh,sh in [(True,False),(False,True),(False,False)]:
 for path in [False,True]:
  for name,c in ctrls.items():
   frame=addr('APRS',high=dh)+addr('N0CALL',3,last=not path,high=sh)
   if path: frame+=addr('WIDE1',1,high=True)+addr('WIDE2',2,last=True)
   frame+=bytes([c])
   if name.startswith('I') or name.startswith('UI'): frame+=bytes([0xf0])
   frame+=b'>synthetic'
   f=root+'/x.raw';open(f,'wb').write(signal(frame))
   p=subprocess.run([binary,'-q','-t','raw','-a','AFSK1200',f],capture_output=True,text=True)
   print(p.stdout.split('\n')[0])
