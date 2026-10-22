"""Validate stable question identities, two-level topics and complete classification."""
import json
from pathlib import Path

root=Path(__file__).resolve().parents[1]
library=json.loads((root/'public/library.json').read_text())
previous=json.loads((root/'backend/seed/library-before-reorganization.json').read_text())
nodes={node['id']:node for node in library['nodes']}
unique={}
for node in nodes.values():
 if node['parent_id']:assert nodes[node['parent_id']]['parent_id'] is None, node
for question in library['questions']:
 if not question['verified']:continue
 assert question['primary_topic_id'] in question['topic_ids'],question
 assert all(tag in nodes and nodes[tag]['parent_id'] for tag in question['topic_ids']),question
 if question['canonical_id'] in unique:
  assert unique[question['canonical_id']]['primary_topic_id']==question['primary_topic_id'],question
 unique[question['canonical_id']]=question
old={q['canonical_id'] for q in previous['questions'] if q['verified']}
assert old<=set(unique),'Previously imported canonical questions disappeared'
assert not any(node['label_ru']=='Цифры' for node in nodes.values())
assert all('numbers.speeds' not in q['topic_ids'] for q in unique.values() if 'what is a microsleep' in q['question'].lower())
report={
 'schema_version':2,
 'classification_input':'question prompt and answer choices only; explanations excluded',
 'unique_questions':len(unique),'previous_question_ids_preserved':len(old),'new_unique_questions':len(set(unique)-old),
 'sections':[{'id':n['id'],'label':n['label_ru'],'topics':sum(x['parent_id']==n['id'] for x in nodes.values())} for n in nodes.values() if not n['parent_id']],
 'editorial_overrides':len(json.loads((root/'materials/topic-overrides.json').read_text())),
 'unclassified_verified_questions':0
}
(root/'materials/classification-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(f"Validated {len(unique)} unique questions; preserved all {len(old)} previous IDs; two-level hierarchy.")
