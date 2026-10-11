# Private concept test. Fine-tunes helmet model on OpenImages-style GitHub set + Roboflow fit split.
import os,json,random,shutil,subprocess,sys,urllib.request,glob
os.chdir('/content')
if not os.path.exists('ts'):subprocess.run('git clone -q --depth 1 https://github.com/TheSiddheshFulawade/YOLO-dataset-with-annotations-for-Helmet-No-Helmet-Motorcycles-and-Numberplates ts',shell=True,check=True)
subprocess.run('pip -q install ultralytics huggingface_hub',shell=True)
B='https://raw.githubusercontent.com/arslanmohammed52/camera-alert-test/main/colab/'
urllib.request.urlretrieve(B+'holdout_oi.json','holdout_oi.json')
if not os.path.exists('helmet.pt'):
    from huggingface_hub import hf_hub_download
    shutil.copy(hf_hub_download('Smolry/Helmet-classifer','helmet.pt'),'helmet.pt')
hold=set(json.load(open('holdout_oi.json')))
S='ts';fs=sorted(f[:-4] for f in os.listdir(S+'/images'))
def conv(b):
    L=[l.split() for l in open(f'{S}/labels/{b}.txt') if l.strip()]
    L=[(int(a[0]),*map(float,a[1:5])) for a in L];H=[l for l in L if l[0]==0];out=[(0,*l[1:]) for l in H]
    for k,x,y,w,h in [l for l in L if l[0]==1]:
        ov=any(max(0,min(x+w/2,hx+hw/2)-max(x-w/2,hx-hw/2))*max(0,min(y+h/2,hy+hh/2)-max(y-h/2,hy-hh/2))>0.3*w*h for _,hx,hy,hw,hh in H)
        if not ov:out.append((1,x,y,w,h))
    return out
rest=[b for b in fs if b not in hold];random.Random(2).shuffle(rest)
nv=150;split={'val':rest[:nv],'fit':rest[nv:],'test':sorted(hold)}
O='/content/d'
shutil.rmtree(O,ignore_errors=True)
for s,bs in split.items():
    os.makedirs(f'{O}/{s}/images');os.makedirs(f'{O}/{s}/labels')
    for b in bs:
        o=conv(b)
        if not o:continue
        os.symlink(f'/content/{S}/images/{b}.jpg',f'{O}/{s}/images/{b}.jpg')
        open(f'{O}/{s}/labels/{b}.txt','w').write(''.join(f'{a} {x} {y} {w} {h}\n' for a,x,y,w,h in o))
print({s:len(os.listdir(f'{O}/{s}/images')) for s in split})
open('/content/d.yaml','w').write(f'path: {O}\ntrain: fit/images\nval: val/images\ntest: test/images\nnames:\n  0: helmet\n  1: no_helmet\n')
from ultralytics import YOLO
def ev(w,split,confs):
    m=YOLO(w)
    for c in confs:
        r=m.val(data='/content/d.yaml',split=split,conf=c,iou=0.6,verbose=False,plots=False)
        print('EVAL',w.split('/')[-3] if '/' in w else w,split,c,[(n,round(float(p),3),round(float(rc),3)) for n,p,rc in zip(['helmet','no_helmet'],r.box.p,r.box.r)],flush=True)
CF=[0.1,0.25,0.4]
ev('helmet.pt','val',CF);ev('helmet.pt','test',[0.25])
m=YOLO('helmet.pt')
m.train(data='/content/d.yaml',epochs=40,patience=10,imgsz=640,batch=16,lr0=0.002,freeze=10,project='/content/runs',name='oi',exist_ok=True,verbose=False,plots=False)
w='/content/runs/oi/weights/best.pt'
ev(w,'val',CF)
print('FROZEN: pick conf with best no_helmet recall at helmet P>=0.7 on val above; test below is run once')
