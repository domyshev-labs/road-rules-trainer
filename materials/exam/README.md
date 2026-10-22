# Exam collection captures

Collection: English, Exam collection.

Question identity is collection + source ticket + source ordinal. Exam training IDs are 100000 + source ticket; thematic IDs are unchanged. Raw captures retain all original question numbers, explanations, image filenames and source-confirmed answers. Only questions with exactly one confirmed answer are imported for training. Deferred questions have no confirmed answer and remain in the captures and deferred list; proposed answers are not answer keys. Training array indexes may differ from source ordinals when deferred questions are excluded. Images for confirmed questions are in public/tests/exam/<source ticket>/q<source ordinal>.jpg.

Topic navigation supports multiple labels per question. Classification uses prompt and answer text only, with canonical editorial overrides in topic-overrides.json. Explanations never enter classification. Every classified question has a primary topic and directly relevant optional secondary topics. Collection membership is independent of topic membership.
