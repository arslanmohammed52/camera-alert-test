# Private helmet fine-tuning runner, for a user-started Colab GPU session.
# This source file contains no dataset images, model weights, credentials or keys.
# Dependencies and downloaded assets keep their own licences:
# Ultralytics and Smolry/Helmet-classifer: AGPL-3.0; base-weight provenance remains incomplete.
# cute-face/bike-helmet-dataset card: CC-BY-4.0; use only pinned train/valid COCO folders.
# Dataset source: https://huggingface.co/datasets/cute-face/bike-helmet-dataset
# Base source: https://huggingface.co/Smolry/Helmet-classifer
# Outputs remain in the private runtime. This runner does not upload or publish outputs.
# No commercial clearance, test accuracy or training completion is claimed by this file.
import os,sys,subprocess,json,pathlib,urllib.request,hashlib,time
os.chdir('/content')
class Tee:
 def __init__(self,*streams):self.streams=streams
 def write(self,s):
  for f in self.streams:f.write(s);f.flush()
 def flush(self):
  for f in self.streams:f.flush()
 def isatty(self):return False
 def __getattr__(self,key):return getattr(self.streams[0],key)
sys.stdout=Tee(sys.stdout,open('/content/helmet_progress.log','a'))
sys.stderr=Tee(sys.stderr,open('/content/helmet_errors.log','a'))
def record_error(kind,value,tb):
 pathlib.Path('/content/helmet_status.json').write_text(json.dumps({'status':'failed','error_type':kind.__name__,'error':str(value),'at':time.time()}))
 sys.__excepthook__(kind,value,tb)
sys.excepthook=record_error
pathlib.Path('/content/helmet_status.json').write_text(json.dumps({'status':'setup','at':time.time()}))
subprocess.run([sys.executable,'-m','pip','-q','install','ultralytics','huggingface_hub'],check=True)
from huggingface_hub import hf_hub_download
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
root=pathlib.Path('/content/helmet_private');root.mkdir(exist_ok=True)
repo='cute-face/bike-helmet-dataset';revision='29338f31e9985da07bc6992dde0633676c7b6415'
annotations={}
for split in ['train','valid']:
 p=hf_hub_download(repo,split+'/_annotations.coco.json',repo_type='dataset',revision=revision)
 annotations[split]=json.load(open(p))
print('CATEGORIES',annotations['train']['categories'],flush=True)
group=lambda f:f.split('.rf.')[0]
val_groups={group(i['file_name']) for i in annotations['valid']['images']}
manifest=[]
for split in ['train','valid']:
 out=root/split;(out/'images').mkdir(parents=True,exist_ok=True);(out/'labels').mkdir(exist_ok=True)
 data=annotations[split];cats={c['id']:c['name'] for c in data['categories']};labs={}
 for a in data['annotations']:
  name=cats[a['category_id']]
  if name not in ['With Helmet','Without Helmet']:continue
  labs.setdefault(a['image_id'],[]).append(a)
 chosen=[i for i in data['images'] if i['id'] in labs and not(split=='train' and group(i['file_name']) in val_groups)]
 def get(im):
  f=im['file_name'];p=hf_hub_download(repo,split+'/'+f,repo_type='dataset',revision=revision);dst=out/'images'/f
  if not dst.exists():os.symlink(p,dst)
  lines=[]
  for a in labs[im['id']]:
   x,y,w,h=a['bbox'];cls=0 if cats[a['category_id']]=='With Helmet' else 1
   lines.append(f'{cls} {(x+w/2)/im["width"]} {(y+h/2)/im["height"]} {w/im["width"]} {h/im["height"]}\n')
  (out/'labels'/(pathlib.Path(f).stem+'.txt')).write_text(''.join(lines))
  return {'split':split,'file':f,'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest()}
 with ThreadPoolExecutor(max_workers=8) as pool:manifest.extend(pool.map(get,chosen))
 print('PREPARED',split,len(chosen),flush=True)
# Block exact duplicates across train and validation as well.
val_hashes={r['sha256'] for r in manifest if r['split']=='valid'}
removed=[]
for r in manifest:
 if r['split']=='train' and r['sha256'] in val_hashes:
  (root/'train/images'/r['file']).unlink();(root/'train/labels'/(pathlib.Path(r['file']).stem+'.txt')).unlink();removed.append(r['file'])
(root/'manifest.json').write_text(json.dumps({'dataset':repo,'revision':revision,'licence':'card CC-BY-4.0; private only','images':manifest,'duplicate_train_removed':removed,'test':'not downloaded or scored'},indent=2))
(root/'data.yaml').write_text(f'path: {root}\ntrain: train/images\nval: valid/images\nnames:\n  0: helmet\n  1: no_helmet\n')
base=hf_hub_download('Smolry/Helmet-classifer','helmet.pt')
from ultralytics import YOLO
import torch
assert torch.cuda.is_available(),'GPU missing, no CPU fallback'
pathlib.Path('/content/helmet_status.json').write_text(json.dumps({'status':'training','at':time.time()}))
print('TRAIN_BEGIN',time.time(),'GPU',torch.cuda.get_device_name(0),'BASE_SHA',hashlib.sha256(open(base,'rb').read()).hexdigest(),flush=True)
# Validation only. Old cute-face test is spent and never used to select checkpoint.
model=YOLO(base)
def progress(trainer):
 p={'epoch_completed':int(trainer.epoch)+1,'at':time.time(),'save_dir':str(trainer.save_dir)}
 pathlib.Path('/content/helmet_progress.json').write_text(json.dumps(p))
 print('CHECKPOINT_PROGRESS',p,flush=True)
model.add_callback('on_model_save',progress)
model.train(data=str(root/'data.yaml'),epochs=5,time=.25,patience=5,imgsz=640,batch=16,device=0,workers=2,optimizer='AdamW',lr0=.0005,freeze=10,seed=42,project=str(root/'runs'),name='helmet_short_v2',exist_ok=False,save_period=1,plots=False,verbose=False)
pathlib.Path('/content/helmet_status.json').write_text(json.dumps({'status':'finished','at':time.time(),'best':'/content/helmet_private/runs/helmet_short_v2/weights/best.pt'}))
print('TRAIN_FINISHED_PRIVATE_ONLY',time.time(),str(root/'runs/helmet_short_v2/weights/best.pt'),flush=True)
print('No test evaluation or publishing performed.',flush=True)
