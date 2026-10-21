import argparse,json,re,shutil
from pathlib import Path
repo=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description='Import captured exam questions without duplicating topic content.')
parser.add_argument('--materials',type=Path,default=repo/'materials/exam')
materials=parser.parse_args().materials
def save(p,d):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
tax=json.load(open(repo/'materials/taxonomy.json'))
reviewed={q['question_id']:q['topic_ids'] for q in json.load(open(repo/'materials/reviewed-exam-topics.json'))['questions']}
# Classification uses the question and source explanation; reviewed tags take precedence.
rules={
'routine.drugs':r'drug|cannabis|cocaine','routine.alcohol':r'alcohol','routine.fatigue':r'fatigue|drows|sleep|tired','routine.distraction':r'distract|mobile phone|cell phone','routine.reaction':r'reaction time','routine.emotions':r'aggress|stress|emotion','routine.health':r'medicin|illness|disease','routine.seatbelts':r'seat.?belt','routine.helmets':r'helmet','routine.ecodriving':r'fuel|efficient driving',
'numbers.speeds':r'\d+\s*(?:km/h|kmh|kilometres per hour)','numbers.alcohol':r'\d+[.,]\d+\s*(?:g/|mg/|grams|milligrams)','numbers.dimensions':r'load.*\d+.*(?:metres|percent)|\d+.*(?:metres|percent).*load','numbers.capacity':r'\d+\s*(?:seats|passengers)','numbers.displacement':r'\d+\s*(?:cm3|cm³|cc)','numbers.technical':r'\d+(?:[.,]\d+)?\s*mm',
'numbers.deadlines.itv':r'(?:inspection|itv).*(?:years|months)|(?:years|months).*(?:inspection|itv)','numbers.deadlines.licences':r'(?:licence|license).*(?:renew|validity|expire)','numbers.deadlines.transfer_buyer':r'buyer|purchaser','numbers.deadlines.transfer_seller':r'seller.*(?:days|notify)|sale.*notify',
'signs.speed':r'(?:sign|r-301|r-411).*(?:maximum speed|minimum speed|speed limit)','signs.priority':r'r-1\b|r-2\b|priority sign|give way sign|stop sign','signs.mandatory':r'obligation road signs|compulsory direction|mandatory sign','signs.warning':r'signs that warn|warning sign|p-\d','signs.restrictions':r'prohibition road signs|restriction road signs|entry prohibited','signs.parking':r'(?:r-30[789]|parking sign|no parking sign)','signs.lanes':r'lane signs|lane indication','signs.temporary':r'work.*sign|temporary sign','signs.vehicle_plates':r'v-\d|vehicle plate','signs.markings':r'road marking|yellow line|white line|hatched',
'priority.officer':r'officer|traffic agent','priority.lights':r'traffic light','priority.tram':r'tram','priority.sign':r'priority sign|give way sign|stop sign|r-1\b|r-2\b','priority.cyclists':r'cyclist.*priority|priority.*cyclist','priority.merging':r'merging|join.*traffic','priority.general':r'right of way|priority at|uncontrolled intersection',
'driving.roundabouts':r'roundabout','driving.lanes':r'lane|shoulder','driving.overtaking':r'overtak','driving.parking':r'parking|stopping','driving.pedestrians':r'pedestrian','driving.weather':r'rain|snow|ice\b|fog|aquaplan|wind','driving.braking':r'brak|gear',
'vehicle.lights':r'headlight|dipped beam|main beam|fog light|lighting','vehicle.visibility':r'mirror|visibility','vehicle.passive':r'airbag|head restraint|passive safety','vehicle.tyres':r'tyre|tire pressure','vehicle.passengers':r'passenger|child restraint','vehicle.cargo':r'load|cargo','vehicle.dangerous_goods':r'dangerous goods','vehicle.motorcycles':r'motorcycle|moped','vehicle.classification':r'quadricycle|definition|classified',
'documents.permissions':r'driving licence|driving license|permit','documents.itv':r'inspection|\bitv\b','incidents.scene':r'first aid|injured|accident scene|warning triangle|v-16','incidents.towing':r'tow|breakdown'}
def classify(q):
 if q.get('question_id') in reviewed:return reviewed[q['question_id']]
 # Classify the tested fact, not broad chapter headings such as ALCOHOL AND OTHER DRUGS.
 prompt=(q['question']+' '+' '.join(a['text'] for a in q['answers'] if a.get('correct'))).lower()
 s=prompt+' '+q.get('help','')[:420].lower()
 tags=[k for k,v in rules.items() if re.search(v,s,re.S)]
 # Routine subtopics require a concrete mention in the question/confirmed answer.
 routine_patterns={
  'routine.drugs':r'\bdrug|droga|cannabis|cocaine|cocaína|ecstasy|éxtasis|mdma|\blsd\b|amphetamine|anfetamina',
  'routine.alcohol':r'alcohol|breathaly|alcoholemia',
  'routine.fatigue':r'fatigue|fatiga|drows|somnol|sleep|sueño|tired|cansancio',
  'routine.distraction':r'distract|distracci|phone|teléfono|gps|navigator',
  'routine.reaction':r'reaction time|tiempo de reacción',
  'routine.emotions':r'stress|estrés|aggress|agresiv|emotion|emoción|panic|pánico',
  'routine.health':r'medicin|medicamento|illness|disease|enfermedad',
  'routine.seatbelts':r'seat.?belt|cinturón',
  'routine.helmets':r'helmet|casco',
  'routine.ecodriving':r'fuel|combustible|consumption|consumo|efficient|eficiente'
 }
 tags=[tag for tag in tags if tag not in routine_patterns]
 tags += [tag for tag,pattern in routine_patterns.items() if re.search(pattern,prompt)]
 if re.search(r'tranquillis|tranquiliz|sedative|sedante|medicamento|medication',prompt) and not re.search(r'illegal|narcotic|cannabis|cocaine|cocaína|ecstasy|éxtasis|\blsd\b',prompt):
  tags=[tag for tag in tags if tag!='routine.drugs']
  if 'routine.health' not in tags: tags.append('routine.health')
 return tags or ['routine.safety']
refs=[]
for path in sorted(materials.glob('exam-*-capture.json')):
 d=json.load(open(path));sid=d['source_test_id'];tid=100000+sid;verified=[]
 for n,q in enumerate(d['questions'],1):
  ordinal=q.get('source_ordinal',n);q['source_ordinal']=ordinal;q['question_id']=f'exam:{sid}:{ordinal:02}';q['topic_ids']=classify(q)
  valid=sum(a.get('correct') is True for a in q['answers'])==1 and not q.get('deferred')
  ref={'test_id':tid,'source_test_id':sid,'source_ordinal':ordinal,'question_id':q['question_id'],'question':q['question'],'topic_ids':q['topic_ids'],'verified':valid,'index':len(verified) if valid else None}
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
  refs.append({'test_id':d['test_id'],'source_test_id':d['test_id'],'source_ordinal':i+1,'question_id':f"thematic:{d['test_id']}:{i+1:02}",'question':q['question'],'topic_ids':classify(q),'verified':True,'index':i})
for node in tax['nodes']:
 node.pop('question_count',None);node.pop('status',None)
save(repo/'public/library.json',{'nodes':tax['nodes'],'questions':refs})
if (materials/'deferred-questions.json').resolve() != (repo/'materials/exam/deferred-questions.json').resolve():
 shutil.copyfile(materials/'deferred-questions.json',repo/'materials/exam/deferred-questions.json')
(repo/'materials/exam/README.md').write_text('''# Exam collection captures\n\nCollection: English, Exam collection.\n\nQuestion identity is collection + source ticket + source ordinal. Exam training IDs are 100000 + source ticket; thematic IDs are unchanged. Raw captures retain all original question numbers, explanations, source image URLs and source-confirmed answers. Only questions with exactly one confirmed answer are imported for training. Deferred questions have no confirmed answer and remain in the captures and deferred list; proposed answers are not answer keys. Training array indexes may differ from source ordinals when deferred questions are excluded. Images for confirmed questions are in public/tests/exam/<source ticket>/q<source ordinal>.jpg.\n\nTopic navigation supports multiple labels per question. The first 60 exam questions use the reviewed classification; remaining questions use provisional keyword-assisted classifications from their prompt and source headings. These labels need editorial review. Collection membership is independent of topic membership.\n''')
print('References',len(refs),'verified',sum(q['verified'] for q in refs),'deferred',sum(not q['verified'] for q in refs))

import hashlib
r=repo
def key(q):
 norm=lambda s:' '.join(s.lower().split())
 parts=[norm(q['question']),q.get('image_url','').split('/')[-1]]+sorted(norm(a['text']) for a in q['answers'])
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
p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
(r/'materials/exam/question-memberships.json').write_text(json.dumps(list(bank.values()),ensure_ascii=False,indent=2)+'\n')
print(len(ids),'ticket positions,',len(bank),'unique confirmed questions')

# The server and frontend share the same membership metadata.
shutil.copyfile(repo/'public/library.json',repo/'backend/seed/library.json')
