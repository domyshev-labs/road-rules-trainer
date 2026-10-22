import argparse,json,re,shutil
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description='Import captured exam questions without duplicating topic content.')
parser.add_argument('--materials',type=Path,default=repo/'materials/exam')
materials=parser.parse_args().materials
def save(p,d):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
tax=json.load(open(repo/'materials/taxonomy.json'))
import importlib.util, hashlib
spec=importlib.util.spec_from_file_location('topic_classification',repo/'scripts/topic-classification.py')
classifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(classifier)
overrides_path=repo/'materials/topic-overrides.json'
overrides=json.loads(overrides_path.read_text()) if overrides_path.exists() else {}
def classify(q):
 norm=lambda value:' '.join(value.lower().split())
 parts=[norm(q['question']),(q.get('image_url') or '').rsplit('/',1)[-1]]+sorted(norm(a['text']) for a in q['answers'])
 cid=hashlib.sha256('\n'.join(parts).encode()).hexdigest()[:24]
 tags,primary=classifier.classify_text(q['question'],q['answers'])
 if cid in overrides:
  tags=overrides[cid]['topic_ids'];primary=overrides[cid]['primary_topic_id']
 q['primary_topic_id']=primary
 q['classification_review_required']=not tags
 return tags
refs=[]
for path in sorted(materials.glob('exam-*-capture.json')):
 d=json.load(open(path))
 if d.get('status') == 'in_progress': continue
 d['source']='';sid=d['source_test_id'];tid=100000+sid;verified=[]
 for n,q in enumerate(d['questions'],1):
  # Keep only the image filename; remote origins must not be persisted.
  q['image_url']=(q.get('image_url') or '').rsplit('/',1)[-1]
  ordinal=q.get('source_ordinal',n);q['source_ordinal']=ordinal;q['question_id']=f'exam:{sid}:{ordinal:02}';q['topic_ids']=classify(q)
  valid=sum(a.get('correct') is True for a in q['answers'])==1 and not q.get('deferred')
  ref={'test_id':tid,'source_test_id':sid,'source_ordinal':ordinal,'question_id':q['question_id'],'question':q['question'],'topic_ids':q['topic_ids'],'primary_topic_id':q['primary_topic_id'],'verified':valid,'index':len(verified) if valid else None}
  refs.append(ref)
  if valid:
   image=f'/tests/exam/{sid}/q{ordinal:02}.jpg' if q.get('local_image') else ''
   if image:
    imagefile=repo/'public'/image.lstrip('/');imagefile.parent.mkdir(parents=True,exist_ok=True)
    if (materials/q['local_image']).exists(): shutil.copyfile(materials/q['local_image'],imagefile)
    elif not imagefile.exists(): raise FileNotFoundError(materials/q['local_image'])
   verified.append({**q,'local_image':image})
 save(repo/f'materials/exam/exam-{sid}-capture.json',d)
 save(repo/f'backend/seed/test-{tid}.json',{'test_id':tid,'title':f'Exam collection · {sid}','collection':'Exam Test','questions':verified})
for path in sorted((repo/'backend/seed').glob('test-*.json')):
 d=json.load(open(path))
 if d.get('collection')!='Thematic Test':continue
 for i,q in enumerate(d['questions']):
  refs.append({'test_id':d['test_id'],'source_test_id':d['test_id'],'source_ordinal':i+1,'question_id':f"thematic:{d['test_id']}:{i+1:02}",'question':q['question'],'topic_ids':classify(q),'primary_topic_id':q.get('primary_topic_id'),'verified':True,'index':i})
for node in tax['nodes']:
 node.pop('question_count',None);node.pop('status',None)
save(repo/'public/library.json',{'nodes':tax['nodes'],'questions':refs})
if (materials/'deferred-questions.json').resolve() != (repo/'materials/exam/deferred-questions.json').resolve():
 shutil.copyfile(materials/'deferred-questions.json',repo/'materials/exam/deferred-questions.json')
(repo/'materials/exam/README.md').write_text('''# Exam collection captures\n\nCollection: English, Exam collection.\n\nQuestion identity is collection + source ticket + source ordinal. Exam training IDs are 100000 + source ticket; thematic IDs are unchanged. Raw captures retain all original question numbers, explanations, image filenames and source-confirmed answers. Only questions with exactly one confirmed answer are imported for training. Deferred questions have no confirmed answer and remain in the captures and deferred list; proposed answers are not answer keys. Training array indexes may differ from source ordinals when deferred questions are excluded. Images for confirmed questions are in public/tests/exam/<source ticket>/q<source ordinal>.jpg.\n\nTopic navigation supports multiple labels per question. Classification uses prompt and answer text only, with canonical editorial overrides in topic-overrides.json. Explanations never enter classification. Every classified question has a primary topic and directly relevant optional secondary topics. Collection membership is independent of topic membership.\n''')
print('References',len(refs),'verified',sum(q['verified'] for q in refs),'deferred',sum(not q['verified'] for q in refs))

import hashlib
r=repo
def key(q):
 norm=lambda s:' '.join(s.lower().split())
 parts=[norm(q['question']),(q.get('image_url') or '').split('/')[-1]]+sorted(norm(a['text']) for a in q['answers'])
 return hashlib.sha256('\n'.join(parts).encode()).hexdigest()[:24]
ids={};bank={}
for p in sorted((r/'backend/seed').glob('test-*.json')):
 d=json.load(open(p))
 if 'questions' not in d:continue
 for i,q in enumerate(d['questions']):
  cid=key(q);q['canonical_id']=cid;sid=d['test_id']%100000;ordinal=q.get('source_ordinal',i+1);qid=f"{'exam' if d['collection']=='Exam Test' else 'thematic'}:{sid}:{ordinal:02}"
  ids[qid]=cid
  bank.setdefault(cid,{'id':cid,'question':q['question'],'memberships':[]})['memberships'].append({'collection':d['collection'],'source_test_id':sid,'source_ordinal':ordinal,'test_id':d['test_id'],'index':i})
 p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
p=r/'public/library.json';d=json.load(open(p))
for q in d['questions']:q['canonical_id']=ids.get(q['question_id'],q['question_id'])
for q in d['questions']:
 if q['canonical_id'] in bank:
  group=[x for x in d['questions'] if x['canonical_id']==q['canonical_id']]
  q['topic_ids']=sorted({tag for x in group for tag in x['topic_ids']})
# Russian list titles are presentation metadata and never change question identity.
titles_path=r/'materials/question-titles-ru.json'
titles=json.loads(titles_path.read_text())['titles'] if titles_path.exists() else {}
for q in d['questions']:
 if q['canonical_id'] in titles:q['question_ru']=titles[q['canonical_id']]
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
(r/'materials/exam/question-memberships.json').write_text(json.dumps(list(bank.values()),ensure_ascii=False,indent=2)+'\n')
print(len(ids),'ticket positions,',len(bank),'unique confirmed questions')

# The server and frontend share the same membership metadata.
shutil.copyfile(repo/'public/library.json',repo/'backend/seed/library.json')
