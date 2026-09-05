import { useEffect, useMemo, useState } from 'react';
import catalogData from './catalog.json';

type Answer = { letter: string; text: string; correct: boolean };
type Question = {
  number: string;
  question: string;
  answers: Answer[];
  help: string;
  image_url: string | null;
  local_image: string | null;
};
type TestRecord = { test_id: number; title: string; questions: Question[] };
type CatalogEntry = { id: number; title: string; questions: number; translated: boolean };
type HelpLanguage = 'ru' | 'es' | 'en';
type HelpTranslations = { help: Record<string, Record<HelpLanguage, string>> };

const catalog = catalogData as CatalogEntry[];

function shuffle(values: number[]) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function BilingualText({ text }: { text: string }) {
  const [spanish = '', ...englishParts] = text.split('\n');
  return (
    <span className="bilingual">
      <span lang="es">{spanish}</span>
      <span lang="en">{englishParts.join(' ')}</span>
    </span>
  );
}

function HelpContent({ text }: { text: string }) {
  const blocks = text
    .replace(/\u00a0/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .replace(/(?<!^)(?=\d+(?:\.\d+){1,2}\s+[A-Z])/g, '\n')
    .replace(/(?<=[a-z)])(?=S-\d)/g, '\n')
    .replace(
      /(?<=[a-z):])(?=(?:Indicates|It indicates|These signs|On roads|When the|A continuous|A broken|Advance warning|Announces|Stopping, parking))/g,
      '\n',
    )
    .replace(/(?<=[.!?])(?=[A-Z])/g, '\n')
    .replace(/(\(Página[^)]+\))/g, '\n$1\n')
    .split('\n')
    .map((block) => block.trim())
    .filter(Boolean);

  return (
    <div className="help-content">
      {blocks.map((block, index) => {
        const isPage = /^\((?:Página|Страница)/.test(block);
        const isHeading =
          /^\d+(?:\.\d+){0,2}\s+[A-Z]/.test(block) ||
          /^S-\d/.test(block) ||
          (!/[.!?]$/.test(block) && block.length < 105);

        if (isPage) return <p className="help-page" key={index}>{block}</p>;
        if (isHeading) return <h3 className="help-heading" key={index}>{block}</h3>;
        return <p className="help-paragraph" key={index}>{block}</p>;
      })}
    </div>
  );
}

export default function App() {
  const [testId, setTestId] = useState(1015);
  const [test, setTest] = useState<TestRecord | null>(null);
  const [translations, setTranslations] = useState<HelpTranslations | null>(null);
  const [loadError, setLoadError] = useState('');
  const [order, setOrder] = useState<number[]>([]);
  const [position, setPosition] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [mistakes, setMistakes] = useState<number[]>([]);
  const [finished, setFinished] = useState(false);
  const [helpLanguage, setHelpLanguage] = useState<HelpLanguage>('ru');

  useEffect(() => {
    let active = true;
    const entry = catalog.find((item) => item.id === testId);

    async function loadTest() {
      try {
        const response = await fetch(`/data/test-${testId}.json`);
        if (!response.ok) throw new Error('Test data unavailable');
        const loaded = (await response.json()) as TestRecord;
        if (!active) return;
        setTest(loaded);
        setOrder(shuffle(loaded.questions.map((_, index) => index)));

        if (entry?.translated) {
          const helpResponse = await fetch(`/data/test-${testId}-help.json`);
          if (helpResponse.ok && active) setTranslations((await helpResponse.json()) as HelpTranslations);
        }
      } catch {
        if (active) setLoadError('Не удалось загрузить билет. Обновите страницу.');
      }
    }

    loadTest();
    return () => { active = false; };
  }, [testId]);

  function selectTest(nextTestId: number) {
    const entry = catalog.find((item) => item.id === nextTestId);
    setTestId(nextTestId);
    setTest(null);
    setLoadError('');
    setTranslations(null);
    setOrder([]);
    setPosition(0);
    setSelected(null);
    setScore(0);
    setMistakes([]);
    setFinished(false);
    setHelpLanguage(entry?.translated ? 'ru' : 'en');
  }

  const questions = test?.questions ?? [];
  const questionIndex = order[position] ?? 0;
  const question = questions[questionIndex];
  const correct = question?.answers.find((answer) => answer.correct);
  const answered = selected !== null;
  const selectedIsCorrect = selected === correct?.letter;
  const progress = useMemo(
    () => order.length ? Math.round(((position + (answered ? 1 : 0)) / order.length) * 100) : 0,
    [answered, order.length, position],
  );

  function chooseAnswer(letter: string) {
    if (answered) return;
    setSelected(letter);
    if (letter === correct?.letter) setScore((value) => value + 1);
    else setMistakes((items) => items.includes(questionIndex) ? items : [...items, questionIndex]);
  }

  function nextQuestion() {
    if (position >= order.length - 1) {
      setFinished(true);
      return;
    }
    setPosition((value) => value + 1);
    setSelected(null);
  }

  function startRound(nextOrder: number[]) {
    setOrder(shuffle(nextOrder));
    setPosition(0);
    setSelected(null);
    setScore(0);
    setMistakes([]);
    setFinished(false);
  }

  if (loadError) return <main className="loading error-message">{loadError}</main>;
  if (!test || !question || !order.length) return <main className="loading">Загружаем билет…</main>;

  if (finished) {
    const percent = Math.round((score / order.length) * 100);
    return (
      <main className="result-page">
        <section className="result-card">
          <p className="eyebrow">Test {test.test_id} · раунд завершён</p>
          <div className="result-ring" style={{ '--score': `${percent * 3.6}deg` } as React.CSSProperties}>
            <strong>{score}/{order.length}</strong><span>{percent}%</span>
          </div>
          <h1>{percent >= 90 ? 'Отличный результат' : percent >= 70 ? 'Хорошая работа' : 'Продолжим тренировку'}</h1>
          <p>Ошибок: {mistakes.length}. Вопросы можно пройти заново в другом порядке.</p>
          <div className="result-actions">
            {mistakes.length > 0 && <button className="primary" onClick={() => startRound(mistakes)}>Повторить ошибки</button>}
            <button className="secondary" onClick={() => startRound(questions.map((_, index) => index))}>Новый раунд</button>
          </div>
        </section>
      </main>
    );
  }

  const helpText =
    translations?.help[String(questionIndex + 1)]?.[helpLanguage] ??
    question.help;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <p className="eyebrow">Thematic Test {test.test_id}</p>
          <h1>{test.title}</h1>
        </div>
        <div className="header-tools">
          <label className="ticket-picker">
            <span>Билет</span>
            <select value={testId} onChange={(event) => selectTest(Number(event.target.value))}>
              {catalog.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.id} · {item.title} ({item.questions})
                </option>
              ))}
            </select>
          </label>
          <div className="score" aria-label={`Счёт ${score}`}><span>Верно</span><strong>{score}</strong></div>
        </div>
      </header>

      <div className="progress-row">
        <span>Вопрос {position + 1} из {order.length}</span>
        <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
        <span>{progress}%</span>
      </div>

      <section className="quiz-card">
        <div className="visual-panel">
          <div className="question-number">#{questionIndex + 1}</div>
          <img
            src={`/tests/${test.test_id}/q${String(questionIndex + 1).padStart(2, '0')}.jpg`}
            alt={`Иллюстрация к вопросу ${questionIndex + 1}`}
          />
        </div>

        <div className="question-panel">
          <h2><BilingualText text={question.question} /></h2>
          <div className="answers">
            {question.answers.map((answer) => {
              const state = answered
                ? answer.correct
                  ? 'correct'
                  : answer.letter === selected
                    ? 'wrong'
                    : 'muted'
                : '';
              return (
                <button
                  key={answer.letter}
                  className={`answer ${state}`}
                  onClick={() => chooseAnswer(answer.letter)}
                  disabled={answered}
                >
                  <span className="answer-letter">{answer.letter}</span>
                  <BilingualText text={answer.text} />
                </button>
              );
            })}
          </div>

          {answered && (
            <aside className={`feedback ${selectedIsCorrect ? 'success' : 'error'}`} aria-live="polite">
              <div className="feedback-title">
                <strong>{selectedIsCorrect ? 'Верно' : `Неверно · правильный ответ ${correct?.letter}`}</strong>
                <span>{selectedIsCorrect ? '✓' : '!'}</span>
              </div>
              <details open>
                <summary>Ayuda · объяснение</summary>
                {translations ? (
                  <div className="help-languages" aria-label="Язык объяснения">
                    {([
                      ['ru', 'RU'],
                      ['es', 'ES'],
                      ['en', 'EN'],
                    ] as const).map(([language, label]) => (
                      <button
                        key={language}
                        type="button"
                        className={helpLanguage === language ? 'active' : ''}
                        onClick={() => setHelpLanguage(language)}
                        aria-pressed={helpLanguage === language}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="translation-status">EN · оригинал сайта</p>
                )}
                <HelpContent text={helpText} />
              </details>
            </aside>
          )}

          <div className="controls">
            <button className="shuffle-button" onClick={() => startRound(questions.map((_, index) => index))}>↻ Перемешать</button>
            <button className="primary next" onClick={nextQuestion} disabled={!answered}>
              {position === order.length - 1 ? 'Результат' : 'Следующий вопрос'} →
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
