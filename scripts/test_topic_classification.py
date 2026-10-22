"""Regression checks for unrelated keyword matches and numeric examples."""
import importlib.util
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('classification',Path(__file__).with_name('topic-classification.py'))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class ClassificationTests(unittest.TestCase):
 def classify(self,prompt,answer):
  return module.classify_text(prompt,[{'text':answer,'correct':True}])
 def test_microsleep_is_not_speed(self):
  tags,primary=self.classify('What is a microsleep?','A few seconds asleep without realising it.')
  self.assertEqual(primary,'routine.fatigue');self.assertNotIn('numbers.speeds',tags)
 def test_police_is_not_ice(self):
  tags,_=self.classify('A traffic police officer signals you to stop. What must you do?','Stop.')
  self.assertIn('priority.officer',tags);self.assertNotIn('conditions.ice',tags)
 def test_windows_are_not_wind(self):
  tags,_=self.classify('To save fuel, should the windows be closed?','Yes.')
  self.assertNotIn('conditions.wind',tags)
 def test_lighting_threshold_is_not_speed_limit(self):
  tags,primary=self.classify('What lights must a car travelling at less than 40 kilometres per hour use?','The dipped beams.')
  self.assertEqual(primary,'vehicle.lights');self.assertNotIn('numbers.speeds',tags)
 def test_mirror_speed_condition_is_not_a_speed_limit_question(self):
  tags,_=self.classify('How many mirrors must a motorcycle have if its speed does not exceed 100 km/h?','One left wing mirror.')
  self.assertNotIn('numbers.speeds',tags)
 def test_incorrect_options_do_not_assign_drug_theme(self):
  tags,_=module.classify_text('Which lights are required?',[{'text':'Dipped beams','correct':True},{'text':'Drugs and alcohol','correct':False}])
  self.assertNotIn('routine.drugs',tags);self.assertNotIn('routine.alcohol',tags)
if __name__=='__main__':unittest.main()
