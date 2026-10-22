import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { readRoute, useTrainingNavigation } from './navigation';

type Answer = { letter: string; text: string; correct?: boolean };
type Question = {
  canonical_id?: string;
  number: string;
  question: string;
  answers: Answer[];
  help: string;
  image_url: string | null;
  local_image: string | null;
};
type TicketCollection = 'Thematic Test' | 'Exam Test';
type TestRecord = { test_id: number; title: string; collection: TicketCollection; questions: Question[]; translations?: HelpTranslations };
type AuthUser = { id: string; email: string };
type CatalogEntry = { id: number; title: string; collection: TicketCollection; questions: number; translated: boolean };
type HelpLanguage = 'ru' | 'es' | 'en';
type HelpTranslations = { help: Record<string, Record<HelpLanguage, string>> };
type RoundMode = 'full' | 'mistakes';
type AnswerHistory = Record<string, boolean>;
type AttemptAnswerDetail = { selectedLetter: string | null; correctLetter: string; correct: boolean };
type AttemptHistory = {
  id: string;
  startedAt: string;
  endedAt: string;
  completed: boolean;
  mode: RoundMode;
  answered: number;
  correct: number;
  wrong: number;
  total: number;
  answers: AnswerHistory;
  answerDetails?: Record<string, AttemptAnswerDetail>;
};
type SavedProgress = {
  order: number[];
  position: number;
  selected: string | null;
  score: number;
  mistakes: number[];
  finished: boolean;
  roundMode: RoundMode;
  ticketAnswered: number;
  ticketCorrect?: number;
  ticketWrong?: number;
  attemptId?: string;
  startedAt?: string;
  answers?: AnswerHistory;
  history?: AttemptHistory[];
  pendingRestart?: boolean;
  freshRepeat?: boolean;
  serverAttemptId?: string | null;
  correctLetters?: Record<string, string>;
  updatedAt: string;
};
type QuestionKnowledge = Record<string, { selected_text: string; correct_text: string; correct: boolean; answered_at: string }>;
type ProgressStore = Record<string, SavedProgress>;
type TicketStats = {
  answered: number;
  correct: number;
  wrong: number;
  total?: number;
  startedAt?: string;
  completed?: boolean;
};
type LegacyImportAttempt = {
  source_id: string;
  test_id: number;
  mode: RoundMode;
  total: number;
  started_at: string;
  ended_at: string;
  completed: boolean;
  answers: AnswerHistory;
};

const sourceTicket = (id: number) => id >= 100000 ? id - 100000 : id;
const collectionName = (collection: TicketCollection) => collection === 'Exam Test' ? 'Экзаменационные вопросы' : 'Тематические вопросы';

const progressStorageKey = 'road-rules-trainer-progress-v1';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function readProgress(): ProgressStore {
  try {
    const raw = localStorage.getItem(progressStorageKey);
    return raw ? JSON.parse(raw) as ProgressStore : {};
  } catch {
    return {};
  }
}

function writeProgress(progress: ProgressStore) {
  try {
    localStorage.setItem(progressStorageKey, JSON.stringify(progress));
  } catch {
    // Training still works when storage is unavailable or full.
  }
}

function createAttemptId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function deriveAnswers(progress: SavedProgress): AnswerHistory {
  if (progress.answers && typeof progress.answers === 'object') return progress.answers;
  const answeredInRound = progress.finished
    ? progress.order.length
    : Math.min(progress.position + (progress.selected ? 1 : 0), progress.order.length);
  const mistakes = new Set(progress.mistakes);
  return Object.fromEntries(
    progress.order.slice(0, answeredInRound).map((questionIndex) => [String(questionIndex), !mistakes.has(questionIndex)]),
  );
}

function makeAttemptHistory(
  progress: Pick<SavedProgress, 'attemptId' | 'startedAt' | 'updatedAt' | 'finished' | 'roundMode' | 'order' | 'answers' | 'position' | 'selected' | 'mistakes'>,
): AttemptHistory | null {
  const compatible = progress as SavedProgress;
  const answers = deriveAnswers(compatible);
  const values = Object.values(answers);
  if (!values.length) return null;
  return {
    id: progress.attemptId ?? `${progress.startedAt ?? progress.updatedAt}:${progress.order.join('-')}`,
    startedAt: progress.startedAt ?? progress.updatedAt,
    endedAt: new Date().toISOString(),
    completed: progress.finished,
    mode: progress.roundMode,
    answered: values.length,
    correct: values.filter(Boolean).length,
    wrong: values.filter((correct) => !correct).length,
    total: progress.order.length,
    answers,
  };
}

function appendAttempt(history: AttemptHistory[], attempt: AttemptHistory | null) {
  if (!attempt) return history;
  const withoutSameAttempt = history.filter((item) => item.id !== attempt.id);
  return [...withoutSameAttempt, attempt].slice(-100);
}

function buildLegacyMigrationBatches(): LegacyImportAttempt[][] {
  return Object.entries(readProgress()).flatMap(([storedTestID, progress]) => {
    const testID = Number(storedTestID);
    if (!Number.isInteger(testID)) return [];
    const current = makeAttemptHistory(progress);
    const attempts = appendAttempt(progress.history ?? [], current).map((attempt) => ({
      source_id: `${storedTestID}:${attempt.id}`,
      test_id: testID,
      mode: attempt.mode,
      total: attempt.total,
      started_at: attempt.startedAt,
      ended_at: attempt.endedAt,
      completed: attempt.completed,
      answers: attempt.answers,
    }));
    return attempts.length ? [attempts] : [];
  });
}

function migrationMarkerKey(userID: string) {
  return `road-rules-trainer-migration-v1:${userID}`;
}

function hasMigrationMarker(userID: string) {
  try {
    return localStorage.getItem(migrationMarkerKey(userID)) === 'done';
  } catch {
    return false;
  }
}

function saveMigrationMarker(userID: string) {
  try {
    localStorage.setItem(migrationMarkerKey(userID), 'done');
  } catch {
    // A completed server import is still safe even if the local marker cannot be saved.
  }
}

function timestamp(value: string | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function chooseInitialTest(entries: CatalogEntry[], remote: Record<string, TicketStats>, saved: ProgressStore) {
  const available = new Set(entries.map((entry) => entry.id));
  const unfinishedLocal = Object.entries(saved)
    .filter(([storedTestID, progress]) => {
      if (!available.has(Number(storedTestID)) || progress.pendingRestart || progress.finished || !progress.serverAttemptId) return false;
      const answered = Object.keys(deriveAnswers(progress)).length;
      return answered > 0 && answered < progress.order.length;
    })
    .sort(([, left], [, right]) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0];
  const latestRemote = entries
    .filter((entry) => (remote[String(entry.id)]?.answered ?? 0) > 0)
    .sort((left, right) => timestamp(remote[String(right.id)]?.startedAt) - timestamp(remote[String(left.id)]?.startedAt))[0];

  if (unfinishedLocal && timestamp(unfinishedLocal[1].updatedAt) >= timestamp(remote[String(latestRemote?.id)]?.startedAt)) {
    return Number(unfinishedLocal[0]);
  }
  if (latestRemote) {
    const progress = remote[String(latestRemote.id)];
    const completed = progress.completed || progress.answered >= (progress.total ?? latestRemote.questions);
    if (!completed) return latestRemote.id;
    const completedIndex = entries.findIndex((entry) => entry.id === latestRemote.id);
    return entries[completedIndex + 1]?.id ?? latestRemote.id;
  }
  if (unfinishedLocal) return Number(unfinishedLocal[0]);

  return entries[0]?.id ?? 1001;
}

function isValidProgress(value: unknown, questionCount: number): value is SavedProgress {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SavedProgress>;
  const validOrder =
    Array.isArray(item.order) &&
    item.order.length > 0 &&
    new Set(item.order).size === item.order.length &&
    item.order.every((index) => Number.isInteger(index) && index >= 0 && index < questionCount);
  const validMistakes =
    Array.isArray(item.mistakes) &&
    item.mistakes.every((index) => Number.isInteger(index) && index >= 0 && index < questionCount);

  return Boolean(
    validOrder &&
    validMistakes &&
    Number.isInteger(item.position) &&
    item.position! >= 0 &&
    item.position! < item.order!.length &&
    (item.selected === null || typeof item.selected === 'string') &&
    Number.isInteger(item.score) &&
    item.score! >= 0 &&
    item.score! <= item.order!.length &&
    typeof item.finished === 'boolean' &&
    (item.roundMode === 'full' || item.roundMode === 'mistakes') &&
    Number.isInteger(item.ticketAnswered) &&
    item.ticketAnswered! >= 0 &&
    item.ticketAnswered! <= questionCount
  );
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

function StatsGlyph() {
  return <span className="stats-glyph" aria-hidden="true"><i /><i /><i /></span>;
}

function Modal({
  title,
  eyebrow,
  className = '',
  onClose,
  children,
}: {
  title: string;
  eyebrow?: string;
  className?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`modal-card ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <div>
            {eyebrow && <p>{eyebrow}</p>}
            <h2>{title}</h2>
          </div>
          <button type="button" className="modal-close-icon" aria-label="Закрыть" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">{children}</div>
        <footer className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>Закрыть</button>
        </footer>
      </section>
    </div>
  );
}

function QuestionHistoryDetail({ questionIndex, question, attempts, onClose }: {
  questionIndex: number;
  question: Question;
  attempts: AttemptHistory[];
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const histories = attempts.flatMap((attempt, index) => {
    const detail = attempt.answerDetails?.[String(questionIndex)];
    return detail ? [{ attempt, attemptNumber: index + 1, detail }] : [];
  });
  const [attemptID, setAttemptID] = useState(() => histories.at(-1)?.attempt.id ?? '');
  const selected = histories.find((history) => history.attempt.id === attemptID) ?? histories.at(-1);

  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  if (!selected) return null;
  return (
    <section className="question-history-detail" ref={panelRef} aria-label={`Детали вопроса ${question.number}`}>
      <header>
        <div><span>Вопрос {question.number.replace(/\.$/, '')}</span><strong>{selected.detail.correct ? 'Ответ верный' : 'Допущена ошибка'}</strong></div>
        <button type="button" aria-label="Закрыть детали вопроса" onClick={onClose}>×</button>
      </header>
      {histories.length > 1 && (
        <div className="question-attempt-tabs" aria-label="Выбор прохождения">
          {[...histories].reverse().map((history) => (
            <button key={history.attempt.id} type="button" className={history.attempt.id === selected.attempt.id ? 'active' : ''} onClick={() => setAttemptID(history.attempt.id)}>
              Попытка {history.attemptNumber} {history.detail.correct ? '✓' : '!'}
            </button>
          ))}
        </div>
      )}
      <h4><BilingualText text={question.question} /></h4>
      <div className="question-history-answers">
        {question.answers.map((answer) => {
          const isCorrect = answer.letter === selected.detail.correctLetter;
          const isSelected = answer.letter === selected.detail.selectedLetter;
          return (
            <div className={`${isCorrect ? 'correct' : ''} ${isSelected && !isCorrect ? 'selected-wrong' : ''}`} key={answer.letter}>
              <span className="question-history-letter">{answer.letter}</span>
              <BilingualText text={answer.text} />
              {(isCorrect || isSelected) && <em>{isCorrect ? isSelected ? 'Ваш ответ · верно' : 'Правильный ответ' : 'Ваш ответ'}</em>}
            </div>
          );
        })}
      </div>
      {selected.detail.selectedLetter === null && <p className="legacy-answer-note">Для этого импортированного ответа выбранный вариант не сохранился. Правильный вариант показан выше.</p>}
    </section>
  );
}

function StatisticsContent({ attempts, questions }: { attempts: AttemptHistory[]; questions: Question[] }) {
  const [selectedQuestion, setSelectedQuestion] = useState<number | null>(null);
  const questionCount = questions.length;
  const totals = attempts.reduce(
    (result, attempt) => ({
      answered: result.answered + attempt.answered,
      correct: result.correct + attempt.correct,
      wrong: result.wrong + attempt.wrong,
    }),
    { answered: 0, correct: 0, wrong: 0 },
  );
  const accuracy = totals.answered ? Math.round((totals.correct / totals.answered) * 100) : 0;
  const questionStats = Array.from({ length: questionCount }, (_, questionIndex) => {
    const results = attempts
      .map((attempt) => attempt.answers[String(questionIndex)])
      .filter((result): result is boolean => typeof result === 'boolean');
    const correct = results.filter(Boolean).length;
    return { question: questionIndex + 1, attempts: results.length, correct, wrong: results.length - correct };
  });

  if (!attempts.length) {
    return <div className="empty-statistics"><StatsGlyph /><h3>Пока нет ответов</h3><p>Статистика появится после первого ответа в этом билете.</p></div>;
  }

  return (
    <>
      <div className="statistics-summary">
        <div><span>Прохождений</span><strong>{attempts.length}</strong></div>
        <div><span>Ответов</span><strong>{totals.answered}</strong></div>
        <div className="positive"><span>Верно</span><strong>{totals.correct}</strong></div>
        <div className="negative"><span>Неверно</span><strong>{totals.wrong}</strong></div>
        <div><span>Точность</span><strong>{accuracy}%</strong></div>
      </div>

      <section className="statistics-section">
        <h3>Прохождения</h3>
        <div className="attempt-list">
          {[...attempts].reverse().map((attempt, index) => (
            <article key={attempt.id}>
              <div>
                <strong>Попытка {attempts.length - index}</strong>
                <span>{attempt.mode === 'mistakes' ? 'Работа над ошибками' : attempt.completed ? 'Завершена' : 'Не завершена'}</span>
              </div>
              <time dateTime={attempt.endedAt}>{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(attempt.endedAt))}</time>
              <span className="attempt-progress">{attempt.answered}/{attempt.total}</span>
              <span className="attempt-correct">👍 {attempt.correct}</span>
              <span className="attempt-wrong">👎 {attempt.wrong}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="statistics-section">
        <h3>По вопросам</h3>
        <div className="question-statistics">
          {questionStats.map((item) => (
            <button type="button" disabled={!item.attempts} onClick={() => setSelectedQuestion(item.question - 1)} className={item.attempts ? '' : 'empty'} key={item.question}>
              <strong>#{questions[item.question - 1]?.number.replace(/\.$/, '') ?? item.question}</strong>
              <span>{item.attempts ? `${item.attempts} отв.` : '—'}</span>
              <span className="attempt-correct">👍 {item.correct}</span>
              <span className="attempt-wrong">👎 {item.wrong}</span>
            </button>
          ))}
        </div>
        {selectedQuestion !== null && (
          <QuestionHistoryDetail
            key={selectedQuestion}
            questionIndex={selectedQuestion}
            question={questions[selectedQuestion]}
            attempts={attempts}
            onClose={() => setSelectedQuestion(null)}
          />
        )}
      </section>
    </>
  );
}

function TicketMenu({
  value,
  entries,
  getStats,
  onSelect,
  onRestart,
}: {
  value: number;
  entries: CatalogEntry[];
  getStats: (entry: CatalogEntry) => TicketStats;
  onSelect: (testId: number) => void;
  onRestart: (testId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = entries.find((entry) => entry.id === value) ?? entries[0];

  return (
    <div className="ticket-menu-shell">
      <button
        type="button"
        className="ticket-menu-trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="ticket-menu-trigger-copy">
          <span className="ticket-menu-trigger-label">{active.collection === 'Exam Test' ? 'Экзаменационный билет' : 'Тематический билет'}</span>
          <span className="ticket-menu-trigger-title" title={ticketTitle(active)}>
            <strong>{sourceTicket(active.id)}</strong><i>—</i><span>{ticketTitle(active)}</span>
          </span>
        </span>
        <span className="ticket-menu-chevron" aria-hidden="true">⌄</span>
      </button>

      {open && (
        <>
          <button className="ticket-menu-backdrop" type="button" aria-label="Закрыть список билетов" onClick={() => setOpen(false)} />
          <section className="ticket-menu-panel" aria-label="Список билетов">
            <header>
              <div>
                <p>Билеты</p>
                <strong>{collectionName(active.collection)}</strong>
              </div>
              <button type="button" aria-label="Закрыть" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="ticket-menu-list">
              {entries.filter((entry) => entry.collection === active.collection).map((entry) => {
                const stats = getStats(entry);
                const hasProgress = stats.answered > 0;
                return (
                  <article className={`ticket-menu-row ${entry.id === value ? 'active' : ''}`} key={entry.id}>
                    <button
                      type="button"
                      className="ticket-menu-choice"
                      onClick={() => {
                        onSelect(entry.id);
                        setOpen(false);
                      }}
                    >
                      <span className="ticket-menu-number">{sourceTicket(entry.id)}</span>
                      <span className="ticket-menu-title">{ticketTitle(entry)}<small className="ticket-menu-collection">{entry.collection === 'Exam Test' ? 'Экзаменационный' : 'Тематический'}</small></span>
                      <span className="ticket-menu-stats">
                        <span className="ticket-menu-done">{stats.answered}/{entry.questions}</span>
                        <span className="ticket-menu-correct">✓ {stats.correct}</span>
                        <span className="ticket-menu-wrong">× {stats.wrong}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ticket-menu-restart"
                      disabled={!hasProgress}
                      onClick={() => {
                        onRestart(entry.id);
                        setOpen(false);
                      }}
                    >
                      Заново
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MobileStatusBar({
  testId,
  entries,
  stats,
  total,
  hint,
  getStats,
  onSelect,
  onRestart,
  onHint,
  onStatistics,
}: {
  testId: number;
  entries: CatalogEntry[];
  stats: TicketStats;
  total: number;
  hint: string;
  getStats: (entry: CatalogEntry) => TicketStats;
  onSelect: (testId: number) => void;
  onRestart: (testId: number) => void;
  onHint: (message: string) => void;
  onStatistics: () => void;
}) {
  return (
    <nav className="mobile-status-bar" aria-label="Статус билета">
      <TicketMenu value={testId} entries={entries} getStats={getStats} onSelect={onSelect} onRestart={onRestart} />
      <button type="button" className="mobile-metric mobile-progress" aria-label={`Пройдено ${stats.answered} из ${total}`} onClick={() => onHint(`Пройдено ${stats.answered} из ${total}`)}>
        <span>{stats.answered}/{total}</span>
      </button>
      <button type="button" className="mobile-metric mobile-correct" aria-label={`Верно ${stats.correct}`} onClick={() => onHint(`Верно: ${stats.correct}`)}>
        <span aria-hidden="true">👍</span><strong>{stats.correct}</strong>
      </button>
      <button type="button" className="mobile-metric mobile-wrong" aria-label={`Неверно ${stats.wrong}`} onClick={() => onHint(`Неверно: ${stats.wrong}`)}>
        <span aria-hidden="true">👎</span><strong>{stats.wrong}</strong>
      </button>
      <button type="button" className="mobile-statistics-button" aria-label="Статистика билета" onClick={onStatistics}><StatsGlyph /></button>
      {hint && <output className="mobile-status-hint">{hint}</output>}
    </nav>
  );
}

function AccountMenu({ user, onLogout }: { user: AuthUser; onLogout: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  async function signOut() {
    if (busy) return;
    setBusy(true);
    try { await onLogout(); } finally { setBusy(false); setOpen(false); }
  }
  return <div className="account-menu-shell" ref={menu}>
    <span className="app-version" aria-label="Версия приложения">{import.meta.env.VITE_APP_VERSION || 'dev'}</span>
    <button ref={trigger} type="button" className="account-menu-trigger" aria-label="Меню пользователя" aria-expanded={open} aria-controls="account-menu" onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
    {open && <section id="account-menu" className="account-menu-panel" aria-label="Аккаунт"><p>{user.email}</p><hr /><button type="button" disabled={busy} onClick={signOut}>{busy ? 'Выходим…' : 'Выйти'}</button></section>}
  </div>;
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email }) });
      setStep('code');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось отправить код');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await api<AuthUser>('/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ email, code }) });
      onAuthenticated(user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">Road Rules Trainer</p>
        <h1>{step === 'email' ? 'Войти или зарегистрироваться' : 'Введите код из письма'}</h1>
        <p>{step === 'email' ? 'Пароль не нужен — пришлём одноразовый код на email.' : `Мы отправили шестизначный код на ${email}`}</p>
        <form onSubmit={step === 'email' ? requestCode : verifyCode}>
          {step === 'email' ? (
            <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
          ) : (
            <label>Код<input className="code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" autoFocus /></label>
          )}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="primary" disabled={busy}>{busy ? 'Подождите…' : step === 'email' ? 'Получить код' : 'Войти'}</button>
          {step === 'code' && <button type="button" className="auth-back" onClick={() => { setStep('email'); setCode(''); setError(''); }}>← Изменить email</button>}
        </form>
      </section>
    </main>
  );
}

function MigrationGate({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [batches] = useState<LegacyImportAttempt[][]>(() => buildLegacyMigrationBatches());
  const [complete, setComplete] = useState(() => batches.length === 0 || hasMigrationMarker(user.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const attempts = batches.reduce((sum, batch) => sum + batch.length, 0);
  const answers = batches.reduce(
    (sum, batch) => sum + batch.reduce((batchSum, attempt) => batchSum + Object.keys(attempt.answers).length, 0),
    0,
  );

  async function migrate() {
    setBusy(true);
    setError('');
    try {
      await Promise.all(batches.map((batch) => (
        api('/api/progress/import', { method: 'POST', body: JSON.stringify({ attempts: batch }) })
      )));
      saveMigrationMarker(user.id);
      setComplete(true);
    } catch (migrationError) {
      setError(migrationError instanceof Error ? migrationError.message : 'Не удалось перенести историю');
    } finally {
      setBusy(false);
    }
  }

  if (complete) return <TrainerApp />;

  return (
    <main className="auth-page migration-page">
      <section className="auth-card migration-card">
        <p className="eyebrow">Найдена история на этом устройстве</p>
        <h1>Перенесём результаты в ваш аккаунт</h1>
        <p>До появления аккаунта результаты сохранялись только в Safari. Перенос нужен, чтобы они были доступны после входа на других устройствах.</p>
        <div className="migration-summary" aria-label="История для переноса">
          <div><strong>{attempts}</strong><span>прохождений</span></div>
          <div><strong>{answers}</strong><span>ответов</span></div>
        </div>
        <p className="migration-note">Локальная копия останется на телефоне. Повторный запрос безопасен и не создаст дубликаты.</p>
        {error && <p className="auth-error" role="alert">Перенос не завершён: {error}. Проверьте соединение и повторите.</p>}
        <button type="button" className="primary migration-button" disabled={busy} onClick={migrate}>
          {busy ? 'Переносим…' : 'Перенести историю'}
        </button>
        <button type="button" className="auth-back" disabled={busy} onClick={onLogout}>Выйти и использовать другой email</button>
      </section>
    </main>
  );
}

type LibraryQuestion = { canonical_id: string; test_id: number; source_test_id: number; source_ordinal: number; question_id: string; question: string; question_ru?: string; topic_ids: string[]; verified: boolean; index: number | null };
type TopicNode = { id: string; label_ru: string; parent_id: string | null };
type LibraryData = { nodes: TopicNode[]; questions: LibraryQuestion[] };

type TopicRun = { inherited?: number; kind: 'full' | 'new'; id: number; total: number; answered: number; correct: number; wrong: number; started_at: string; completed_at: string | null; review?: TopicRun };
type TopicLaunch = { reviewParent?: number; newQuestions?: boolean; runId?: number };
type TopicSummary = { repeat_in_progress?: boolean; new_count: number; new_question_ids: string[]; question_runs: Record<string, number>; completed: boolean; runs: TopicRun[]; total: number; answered: number; correct: number; wrong: number; next_question: number; results: Record<string, boolean> };
function questionCount(count: number) {
  const form = new Intl.PluralRules('ru').select(count);
  return `${count} ${form === 'one' ? 'вопрос' : form === 'few' ? 'вопроса' : 'вопросов'}`;
}

function TopicStatistics({ stats, total, onReview }: { stats?: TopicSummary; total: number; onReview: (parent: number) => void }) {
  const [anchor, setAnchor] = useState<{ top: number; right: number; bottom?: number } | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function keepOpen() { if (closeTimer.current) clearTimeout(closeTimer.current); }
  function closeSoon() { keepOpen(); closeTimer.current = setTimeout(() => setAnchor(null), 180); }
  function open() {
    keepOpen();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setAnchor(rect.top > window.innerHeight / 2
      ? { top: 0, bottom: window.innerHeight - rect.top + 6, right: Math.max(12, window.innerWidth - rect.right) }
      : { top: rect.bottom + 6, right: Math.max(12, window.innerWidth - rect.right) });
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!anchor) return;
    function close(event: KeyboardEvent) { if (event.key === 'Escape') { setAnchor(null); trigger.current?.focus(); } }
    function outside(event: PointerEvent) { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setAnchor(null); }
    function scrolled(event: Event) { if (!popup.current?.contains(event.target as Node)) setAnchor(null); }
    document.addEventListener('keydown', close); document.addEventListener('pointerdown', outside); window.addEventListener('scroll', scrolled, true);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', scrolled, true); };
  }, [anchor]);
  return <><span className="topic-counts topic-statistics" ref={trigger} tabIndex={0} role="button" aria-label="История прохождений темы" aria-expanded={!!anchor}
    onMouseEnter={open} onMouseLeave={closeSoon} onFocus={open} onBlur={(event) => { if (!popup.current?.contains(event.relatedTarget as Node)) closeSoon(); }}
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (!anchor) open(); }}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(); } }}>
    <span>Всего: {total}</span><span>Выполнено: {stats?.answered ?? '…'}</span><span>✓ {stats?.correct ?? '…'}</span><span className="wrong-mark">× {stats?.wrong ?? '…'}</span>
  </span>{anchor && createPortal(<div className="topic-history-popover" ref={popup} role="dialog" aria-label="История прохождений темы"
    style={{ right: anchor.right, top: anchor.bottom === undefined ? anchor.top : undefined, bottom: anchor.bottom }}
    onMouseEnter={keepOpen} onMouseLeave={closeSoon} onFocus={keepOpen} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !trigger.current?.contains(event.relatedTarget as Node)) closeSoon(); }}>
    <strong>История прохождений</strong>
    {!stats?.runs.length && <p>Прохождений пока нет.</p>}
    {stats?.runs.map((run, index) => <section key={run.id}><b>{run.kind === 'new' ? 'Новые вопросы' : `Прохождение ${stats.runs.slice(index).filter((item) => item.kind === 'full').length}`}</b><time>{new Date(run.started_at).toLocaleString('ru-RU')}</time>
      <p>{run.completed_at ? 'Завершено' : 'В процессе'} · {run.answered}/{run.total} · ✓ {run.correct} · × {run.wrong}</p>{!!run.inherited && <p>Ранее отвечено в других темах или билетах: {run.inherited}</p>}
      {run.review ? <><p>Работа над ошибками: {run.review.completed_at ? 'выполнена' : 'в процессе'} · {run.review.answered}/{run.review.total} · ✓ {run.review.correct} · × {run.review.wrong}</p>
        <button type="button" onClick={() => { setAnchor(null); onReview(run.id); }}>{run.review.completed_at ? 'Посмотреть работу над ошибками' : 'Продолжить работу над ошибками'}</button></>
        : run.completed_at && run.wrong > 0 ? <button type="button" onClick={() => { setAnchor(null); onReview(run.id); }}>Сделать работу над ошибками</button> : <p>{run.completed_at ? 'Ошибок нет' : 'Работа над ошибками доступна после завершения'}</p>}
    </section>)}
  </div>, document.body)}</>;
}

const thematicTitles = ['Определения', 'Документы', 'Водитель — 1', 'Водитель — 2', 'Водитель — 3', 'Участники дорожного движения', 'Средства безопасности — 1', 'Средства безопасности — 2', 'Средства безопасности — 3', 'Управление, обзор и посадка', 'Освещение и сигналы — 1', 'Освещение и сигналы — 2', 'Дорожные знаки и разметка — 1', 'Дорожные знаки и разметка — 2', 'Дорожные знаки и разметка — 3', 'Использование дороги — 1', 'Использование дороги — 2', 'Скорость и дистанция — 1', 'Скорость и дистанция — 2', 'Скорость и дистанция — 3', 'Манёвры — 1', 'Манёвры — 2', 'Манёвры — 3', 'Приоритет, переезды и тоннели — 1', 'Приоритет, переезды и тоннели — 2', 'Перевозка людей и грузов', 'Безопасное вождение — 1', 'Безопасное вождение — 2', 'Устройство и обслуживание автомобиля', 'ДТП — 1', 'ДТП — 2', 'ДТП — 3', 'Поездки и экономичное вождение'];
function ticketTitle(entry: { id: number; title: string }) {
  return entry.id >= 100000 ? `Экзаменационный билет ${sourceTicket(entry.id)}` : thematicTitles[entry.id - 1001] || entry.title;
}
function PageLoader() {
  return <main className="page-loading" role="status" aria-label="Загрузка"><span className="page-spinner" aria-hidden="true" /></main>;
}

function SectionNavigator({ library, catalog, getStats, sectionId, onOpenTopic }: {
  library: LibraryData; catalog: CatalogEntry[]; getStats: (entry: CatalogEntry) => TicketStats;
  sectionId: string; onOpenTopic: (id: string, question?: string, options?: TopicLaunch) => void;
}) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const section = library.nodes.find((node) => node.id === sectionId);
  function keepOpen() { if (timer.current) clearTimeout(timer.current); }
  function closeSoon() { keepOpen(); timer.current = setTimeout(() => { if (!document.querySelector('.topic-history-popover:hover')) setAnchor(null); }, 180); }
  function open() {
    keepOpen();
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setAnchor({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 652)), top: rect.bottom + 8 });
  }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!anchor) return;
    function close(event: KeyboardEvent) { if (event.key === 'Escape') { setAnchor(null); trigger.current?.focus(); } }
    function outside(event: PointerEvent) { if (!(event.target as Element).closest('.topic-history-popover') && !trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setAnchor(null); }
    document.addEventListener('keydown', close); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', outside); };
  }, [anchor]);
  return <><button className="section-navigation-trigger" type="button" ref={trigger} aria-haspopup="dialog" aria-expanded={!!anchor}
    onMouseEnter={open} onMouseLeave={closeSoon} onFocus={(event) => { if (!popup.current?.contains(event.relatedTarget as Node)) open(); }} onClick={open}
    onBlur={(event) => { if (!popup.current?.contains(event.relatedTarget as Node)) closeSoon(); }}>{section?.label_ru}</button>
    {anchor && createPortal(<div className="section-navigation-popup" role="dialog" aria-label={section?.label_ru} ref={popup}
      style={{ left: anchor.left, top: anchor.top, maxHeight: `calc(100dvh - ${anchor.top + 16}px)` }}
      onMouseEnter={keepOpen} onMouseLeave={closeSoon} onFocus={keepOpen}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !trigger.current?.contains(event.relatedTarget as Node)) closeSoon(); }}>
      <header><strong>{section?.label_ru}</strong><button type="button" aria-label="Закрыть раздел" onClick={() => setAnchor(null)}>×</button></header>
      <QuestionLibrary sectionId={sectionId} library={library} catalog={catalog} getStats={getStats}
        view={{ search: '', collection: null, expanded: [sectionId], scrollTop: 0 }} onRemember={() => undefined}
        onOpen={() => undefined} onOpenTopic={(id, question, options) => { setAnchor(null); onOpenTopic(id, question, options); }} />
    </div>, document.body)}</>;
}

function TopicHeading({ section, title }: { section: React.ReactNode; title: string }) {
  return <><div className="section-heading">{section}</div><div className="theme-heading"><h1>{title}</h1></div></>;
}
type LibraryView = { search: string; expanded: string[]; scrollTop: number; collection: TicketCollection | null; completedTopic?: { id: string; question: string } };

function QuestionLibrary({ catalog, library, onOpen, onOpenTopic, getStats, view, onRemember, sectionId, knowledge }: {
  catalog: CatalogEntry[]; library: LibraryData; onOpen: (id: number, index?: number) => void; onOpenTopic: (id: string, question?: string, options?: TopicLaunch) => void;
  knowledge?: QuestionKnowledge; sectionId?: string; getStats: (entry: CatalogEntry) => TicketStats; view: LibraryView; onRemember: (snapshot: LibraryView) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState(view.search);
  const [expanded, setExpanded] = useState(view.expanded);
  const [collection, setCollection] = useState<TicketCollection | null>(view.collection);
  const [summaries, setSummaries] = useState<Record<string, TopicSummary> | null>(null);
  const [progressError, setProgressError] = useState('');
  useEffect(() => {
    let active = true;
    void api<Record<string, TopicSummary>>('/api/topics/progress').then((data) => { if (active) setSummaries(data); }).catch(() => { if (active) setProgressError('Не удалось загрузить прогресс. Обновите страницу, чтобы продолжить тему.'); });
    return () => { active = false; };
  }, []);
  // Restore after mounting and after progress counts finish changing row heights.
  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container) return;
    container.scrollTop = view.scrollTop;
    if (!summaries || !view.completedTopic) return;
    const branch = Array.from(container.querySelectorAll<HTMLElement>('[data-library-id]')).find((item) => item.dataset.libraryId === view.completedTopic?.id);
    const row = Array.from(branch?.querySelectorAll<HTMLElement>('[data-question-id]') ?? []).find((item) => item.dataset.questionId === view.completedTopic?.question);
    if (row) {
      // Keep the completed answer and the following question or topic in view.
      container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
    }
  }, [summaries, view.scrollTop, view.completedTopic]);
  function toggleBranch(id: string, open: boolean) {
    setExpanded((current) => open ? current.includes(id) ? current : [...current, id] : current.includes(id) ? current.filter((item) => item !== id) : current);
  }
  function rememberView() {
    onRemember({
      search, collection, scrollTop: scroll.current?.scrollTop ?? 0,
      expanded: Array.from(root.current?.querySelectorAll<HTMLDetailsElement>('details[data-library-id][open]') ?? []).map((node) => node.dataset.libraryId!),
    });
  }
  function openTopic(id: string, question?: string, options?: TopicLaunch) { rememberView(); onOpenTopic(id, question, options); }
  async function repeatTopic(id: string) {
    try { await api(`/api/topics/${encodeURIComponent(id)}/reset`, { method: 'POST' }); openTopic(id); }
    catch (err) { setProgressError(err instanceof Error ? err.message : 'Не удалось начать новое прохождение'); }
  }
  function openTicket(id: number, index?: number) { rememberView(); onOpen(id, index); }
  const query = search.trim().toLocaleLowerCase();
  const matches = (q: LibraryQuestion) => !query || `${q.source_test_id} ${q.source_ordinal} ${q.question} ${q.question_ru || ''} ${q.topic_ids.map((id) => library.nodes.find((n) => n.id === id)?.label_ru || '').join(' ')}`.toLocaleLowerCase().includes(query);
  function questionList(items: LibraryQuestion[], unique = false, node?: TopicNode) {
    const seen = new Set<string>();
    if (node) items = items.filter((q) => q.verified);
    if (unique) items = items.filter((q) => { if (seen.has(q.canonical_id)) return false; seen.add(q.canonical_id); return true; });
    if (node) items = [...items].sort((a, b) => a.canonical_id.localeCompare(b.canonical_id));
    return <div className="library-questions">{items.map((q, index) => ({ q, index })).filter(({ q }) => matches(q)).map(({ q, index }) => {
      const result = node ? summaries?.[node.id]?.results[q.canonical_id] : knowledge?.[q.canonical_id]?.correct;
      return <button type="button" key={q.question_id} data-question-id={q.canonical_id} disabled={!q.verified} onClick={() => {
        if (!node) { openTicket(q.test_id, q.index ?? undefined); return; }
        const stats = summaries?.[node.id];
        const options: TopicLaunch = stats?.new_question_ids.includes(q.canonical_id)
          ? { newQuestions: true } : { runId: stats?.question_runs[q.canonical_id] };
        openTopic(node.id, q.canonical_id, options);
      }}>
        <span className={`library-question-id ${node ? 'topic-question-row' : ''}`}>{node ? <><b className="topic-list-number">{index + 1}</b><span className="library-question-title">{q.question_ru || q.question.split('\n').filter(Boolean).at(-1)}</span><i className={result === false ? 'wrong-mark' : ''}>{result === undefined ? '' : result ? '✓' : '×'}</i></> : `${q.test_id >= 100000 ? 'Экзамен' : 'Тематический билет'} ${q.source_test_id} / ${String(q.source_ordinal).padStart(2, '0')}`}{!node && result !== undefined && <i className={result ? '' : 'wrong-mark'}>{result ? '✓' : '×'}</i>}</span>
        {!node && <span>{q.question_ru || q.question.split('\n').filter(Boolean).at(-1)}</span>}{!q.verified && <small>Отложен · ответ не подтверждён</small>}
      </button>;
    })}</div>;
  }
  function topic(node: TopicNode): React.ReactNode {
    const children = library.nodes.filter((n) => n.parent_id === node.id);
    const ids = new Set([node.id, ...children.map((n) => n.id)]);
    const items = library.questions.filter((q) => q.topic_ids.some((id) => ids.has(id)));
    const own = items.filter((q) => q.topic_ids.includes(node.id));
    const count = new Set(items.filter((q) => q.verified).map((q) => q.canonical_id)).size;
    const stats = summaries?.[node.id];
    if (query && !items.some(matches) && !node.label_ru.toLocaleLowerCase().includes(query)) return null;
    return <details className={`library-branch ${children.length ? 'library-section' : ''}`} key={node.id} data-library-id={node.id} open={!!query || expanded.includes(node.id)} onToggle={(event) => { if (!query) toggleBranch(node.id, event.currentTarget.open); }}><summary><span className="library-node-title">{node.label_ru}</span>{children.length ? <span className="topic-counts"><span>Тем: {children.length}</span><span>Пройдено: {summaries ? children.filter((child) => summaries[child.id]?.completed && !summaries[child.id]?.new_count).length : '…'}</span></span> : <TopicStatistics stats={stats} total={count} onReview={(parent) => openTopic(node.id, undefined, { reviewParent: parent })} />}</summary>
      <div className="library-children">{!children.length && count > 0 && <div className="topic-start-actions"><button type="button" className="primary library-start" disabled={!summaries} onClick={() => {
        if (stats?.new_count) { openTopic(node.id, undefined, { newQuestions: true }); return; }
        const fullRun = stats?.runs.find((run) => run.kind === 'full');
        const failedRun = stats?.wrong ? stats.runs.find((run) => run.id >= (fullRun?.id ?? 0) && run.completed_at && run.wrong > 0) : undefined;
        if (stats?.repeat_in_progress) { openTopic(node.id); return; }
        if (stats?.completed) {
          if (failedRun) openTopic(node.id, undefined, { reviewParent: failedRun.id });
          else void repeatTopic(node.id);
        } else openTopic(node.id);
      }}>{stats?.new_count ? 'Пройти новые' : stats?.repeat_in_progress ? 'Продолжить тему' : stats?.answered ? stats.completed ? stats.wrong > 0 ? 'Повторить вопросы с ошибками' : 'Пройти тему снова' : 'Продолжить тему' : 'Начать тему'}{stats?.new_count ? <small>{questionCount(stats.new_count)}</small> : stats && (stats.answered > 0 || stats.repeat_in_progress) && (!stats.completed || stats.repeat_in_progress) && <small>с вопроса {stats.next_question}</small>}</button>
      {!!stats?.new_count && <span className="topic-new-badge" tabIndex={0} title={`Новых неотвеченных вопросов: ${stats.new_count}. Они проходят отдельно; предыдущие результаты сохраняются.`} aria-label={`New: новых вопросов — ${stats.new_count}`}>New</span>}
      {!!stats?.new_count && stats.runs.some((run) => run.kind === 'full' && !run.completed_at) && <button type="button" className="repeat-full-topic" onClick={() => openTopic(node.id)}>Продолжить основное прохождение</button>}
      {!stats?.new_count && stats?.completed && stats.wrong > 0 && <button className="repeat-full-topic" type="button" onClick={() => void repeatTopic(node.id)}>Пройти всю тему снова</button>}</div>}{children.map(topic)}{!children.length && questionList(own, true, node)}{!count && <p className="library-empty">Вопросы появятся по мере пополнения коллекции.</p>}</div>
    </details>;
  }
  return <main className={`library-page ${sectionId ? 'section-library' : ''}`} ref={root}>
    {!sectionId && <>
    <header className="library-header"><a href="/" className="library-brand">Теория вождения</a></header>
    <section className="library-intro"><h1>Выбери предметную тематику для тренировки сейчас</h1>
      <div className="library-totals"><span><strong>{catalog.filter((e) => e.collection === 'Thematic Test').length}</strong> тематических билета</span><span><strong>{catalog.filter((e) => e.collection === 'Exam Test').length}</strong> экзаменационных билетов</span><span><strong>{library.questions.filter((q) => !q.verified).length}</strong> отложенных вопросов</span></div>
      <input aria-label="Поиск вопросов" placeholder="Тема, номер билета или текст вопроса…" value={search} onChange={(event) => setSearch(event.target.value)} />
    </section>
    <nav className="library-collections" aria-label="Коллекции билетов">{(['Thematic Test', 'Exam Test'] as TicketCollection[]).map((item) => <button key={item} onClick={() => setCollection(item)}><strong>{collectionName(item)}</strong><span>{catalog.filter((e) => e.collection === item).length} билета <b>›</b></span></button>)}</nav>
    <div className="library-divider">По темам <span>Один вопрос может входить в несколько тем</span></div>
    </>}
    {progressError && <p className="answer-error" role="alert">{progressError}</p>}
    <div className="library-tree library-scroll" ref={scroll}>{library.nodes.filter((node) => sectionId ? node.id === sectionId : !node.parent_id).map((node) => { const content = topic(node); return content ? <div className="library-root" key={node.id}>{content}</div> : null; })}{query && !library.questions.some(matches) && <p>Ничего не найдено.</p>}{!sectionId && <p className="library-note">Разметка новых вопросов уточняется по мере разбора. Отложенные вопросы пока не участвуют в тренировке.</p>}</div>
    {collection && <Modal title={collectionName(collection)} onClose={() => setCollection(null)} className="collection-modal"><div className="library-tree">{catalog.filter((e) => e.collection === collection).map((entry) => {
      const stats = getStats(entry);
      return <details className="library-branch" key={entry.id} data-library-id={`ticket:${entry.id}`} open={expanded.includes(`ticket:${entry.id}`)} onToggle={(event) => toggleBranch(`ticket:${entry.id}`, event.currentTarget.open)}><summary><span><b>{sourceTicket(entry.id)}</b> · {ticketTitle(entry)}</span><span className="topic-counts"><span>{stats.answered}/{entry.questions}</span><span>✓ {stats.correct}</span><span className="wrong-mark">× {stats.wrong}</span></span></summary><div className="library-children"><button className="primary library-start" onClick={() => openTicket(entry.id)}>Открыть билет</button>{questionList(library.questions.filter((q) => q.test_id === entry.id))}</div></details>;
    })}</div></Modal>}
  </main>;
}

type TopicAnswerProgress = { selected_letter: string; correct_letter: string; correct: boolean };
type TopicQuestion = { id: string; number: number; question: string; question_ru?: string; image_url: string; help: Record<HelpLanguage, string>; answers: Answer[]; sources: LibraryQuestion[]; progress?: TopicAnswerProgress };
type TopicRecord = { run_id: number; kind: 'full' | 'new'; id: string; title: string; questions: TopicQuestion[] };

// Prepare the illustration before switching; failed images never block navigation.
function prepareQuestionImage(url: string | null | undefined, signal: AbortSignal) {
  if (!url || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const image = new Image();
    const finish = () => {
      window.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, 10000);
    signal.addEventListener('abort', finish, { once: true });
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) finish();
  });
}

function NextQuestionButton({ label = 'Следующий вопрос →', disabled, imageUrl, onNext }: {
  label?: string; disabled: boolean; imageUrl?: string | null; onNext: () => void;
}) {
  const [preparing, setPreparing] = useState(false);
  const [pending, startTransition] = useTransition();
  const navigation = useRef<AbortController | null>(null);
  useEffect(() => () => navigation.current?.abort(), []);
  const loading = preparing || pending;
  async function next() {
    if (disabled || loading || navigation.current) return;
    const controller = new AbortController();
    navigation.current = controller;
    setPreparing(true);
    // Give the busy state a paint before preparing and rendering the next question.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await prepareQuestionImage(imageUrl, controller.signal);
    if (controller.signal.aborted) return;
    startTransition(() => {
      onNext();
      setPreparing(false);
    });
    navigation.current = null;
  }
  return <button className="primary next next-loading-button" type="button" disabled={disabled || loading}
    aria-busy={loading} aria-label={loading ? 'Загружаем следующий вопрос' : label} onClick={() => void next()}>
    <span className="next-button-label" aria-hidden={loading}>{label}</span>
    {loading && <span className="question-loader" aria-hidden="true"><span /><span /><span /></span>}
  </button>;
}

function TopicTrainer({ topicId, initialQuestion, reviewParent, newQuestions, runId, path, sectionNavigation, onQuestion, onBack, onFinish }: {
  topicId: string; initialQuestion?: string; reviewParent?: number; newQuestions?: boolean; runId?: number; path: string; sectionNavigation: React.ReactNode; onQuestion: (question: string, replace?: boolean, runId?: number) => void; onBack: () => void; onFinish: (question: string) => void;
}) {
  const [requestedQuestion] = useState(initialQuestion);
  const [topic, setTopic] = useState<TopicRecord | null>(null);
  const [reviewID, setReviewID] = useState<number | undefined>();
  const [initialPosition, setPosition] = useState(0);
  const requestedPosition = topic?.questions.findIndex((item) => item.id === initialQuestion) ?? -1;
  const position = requestedPosition >= 0 ? requestedPosition : initialPosition;
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [language, setLanguage] = useState<HelpLanguage>('ru');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      const review = reviewParent ? await api<{ id: number }>(`/api/topics/${encodeURIComponent(topicId)}/reviews/${reviewParent}`, { method: 'POST' }) : undefined;
      const newRun = newQuestions && !review ? await api<{ id: number }>(`/api/topics/${encodeURIComponent(topicId)}/new`, { method: 'POST' }) : undefined;
      const requestedRun = newRun?.id ?? runId;
      const loaded = await api<TopicRecord>(`/api/topics/${encodeURIComponent(topicId)}${review ? `?review=${review.id}` : requestedRun ? `?run=${requestedRun}` : ''}`);
      return { loaded, review };
    })().then(({ loaded, review }) => {
      if (!active) return;
      setTopic(loaded);
      setReviewID(review?.id);
      const requested = loaded.questions.findIndex((q) => q.id === requestedQuestion);
      const unanswered = loaded.questions.findIndex((q) => !q.progress);
      setPosition(requested >= 0 ? requested : unanswered >= 0 ? unanswered : 0);
    }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : 'Не удалось загрузить подтему'); });
    return () => { active = false; };
  }, [topicId, requestedQuestion, reviewParent, newQuestions, runId]);
  useEffect(() => {
    if (!topic) return;
    const requested = topic.questions.findIndex((item) => item.id === initialQuestion);
    if (requested < 0 && topic.questions[position]) onQuestion(topic.questions[position].id, true, topic.run_id);
  }, [initialQuestion, topic, position, onQuestion]);
  useEffect(() => { panel.current?.scrollTo({ top: 0 }); panel.current?.parentElement?.scrollTo({ top: 0 }); }, [position]);
  useEffect(() => {
    function close(event: KeyboardEvent) { if (event.key === 'Escape') setMenuOpen(false); }
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, []);
  function goTo(index: number) { if (topic?.questions[index]) onQuestion(topic.questions[index].id); setHelpOpen(false); }
  async function answer(letter: string) {
    const question = topic?.questions[position];
    if (!question || question.progress || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<TopicAnswerProgress>(`/api/topics/${encodeURIComponent(topicId)}/answers`, { method: 'POST', body: JSON.stringify({ question_id: question.id, selected_letter: letter, review_id: reviewID, run_id: reviewID ? undefined : topic?.run_id }) });
      setTopic((current) => current ? { ...current, questions: current.questions.map((q) => q.id === question.id ? { ...q, progress: result } : q) } : null);
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось сохранить ответ'); }
    finally { setBusy(false); }
  }
  const q = topic?.questions[position];
  if (!topic || !q) return error ? <main className="loading error-message"><p role="alert">{error}</p><button className="secondary" onClick={onBack}>Панель обучения</button></main> : <PageLoader />;
  const total = topic.questions.length;
  const lastQuestion = position === total - 1;
  const done = topic.questions.filter((item) => item.progress).length;
  const correct = topic.questions.filter((item) => item.progress?.correct).length;
  const filteredRun = !!reviewParent || topic.kind === 'new';
  const finishReady = filteredRun ? done === total : lastQuestion;
  const nextUnanswered = topic.questions.findIndex((item, index) => index > position && !item.progress);
  const nextPosition = filteredRun
    ? nextUnanswered >= 0 ? nextUnanswered : topic.questions.findIndex((item) => !item.progress)
    : position + 1;
  const progress = Math.round(done / total * 100);
  const help = q.help[language] || q.help.en;
  return <>
    <button className="library-back topic-back" type="button" disabled={busy} onClick={onBack}>‹ Панель обучения</button>
    <main className="app-shell topic-shell">
      <header className="topbar topic-topbar">
        <div className="title-block"><TopicHeading section={sectionNavigation} title={topic.title} />{filteredRun && <p className="review-mode-label">{reviewParent ? 'Работа над ошибками · исходный результат сохранён' : 'Новые вопросы · отдельное прохождение'}</p>}</div>
        <div className="header-tools">
          <div className="ticket-menu-shell topic-menu-shell">
            <button type="button" className="ticket-menu-trigger" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><span className="ticket-menu-trigger-copy"><span className="ticket-menu-trigger-label">Текущий вопрос</span><span className="ticket-menu-trigger-title">Вопрос {position + 1} из {total}</span></span><span className="ticket-menu-chevron">⌄</span></button>
            {menuOpen && <><button className="ticket-menu-backdrop" aria-label="Закрыть список вопросов" onClick={() => setMenuOpen(false)} /><section className="ticket-menu-panel topic-menu" aria-label={`Вопросы подтемы ${topic.title}`}><header><div><div className="menu-topic-heading"><p className="menu-section">{path}</p><div className="menu-theme"><strong>{topic.title}</strong></div></div><p className="topic-summary-line">Всего: {total} · Выполнено: {done} · Верно: {correct} · Неверно: {done - correct}</p></div><button aria-label="Закрыть" onClick={() => setMenuOpen(false)}>×</button></header><div className="ticket-menu-list">
              {topic.questions.map((item, index) => <button key={item.id} type="button" className={`topic-menu-question ${index === position ? 'active' : ''}`} onClick={() => { goTo(index); setMenuOpen(false); }}><b>{index + 1}</b><span>{item.question_ru || item.question.split('\n').filter(Boolean).at(-1)}</span><i>{item.progress ? item.progress.correct ? '✓' : '×' : '·'}</i></button>)}
            </div></section></>}
          </div>

          <div className="answer-stats"><div className="score"><span>Верно</span><strong>{correct}</strong></div><div className="score score-wrong"><span>Неверно</span><strong>{done - correct}</strong></div></div>
        </div>
      </header>
      <div className="progress-row"><span>Вопрос {position + 1} из {total}</span><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><span>{progress}%</span></div>
      <section className="quiz-card">
        <div className="visual-panel"><div className="question-number">#{position + 1}</div><div className="visual-media">{q.image_url ? <img src={q.image_url} alt={`Иллюстрация к вопросу ${position + 1}`} /> : <span className="visual-empty">Вопрос без иллюстрации</span>}</div></div>
        <div className="question-panel fixed-question-layout">
          <div className="question-content">
          <div className="question-heading-row"><h2><BilingualText text={q.question} /></h2></div>
          <div className="answer-scroll" ref={panel}><div className="answers">{q.answers.map((choice) => {
            const state = q.progress ? choice.letter === q.progress.correct_letter ? 'correct' : choice.letter === q.progress.selected_letter ? 'wrong' : 'muted' : '';
            return <button type="button" className={`answer ${state}`} key={choice.letter} disabled={!!q.progress || busy} onClick={() => answer(choice.letter)}><span className="answer-letter">{choice.letter}</span><BilingualText text={choice.text} /></button>;
          })}</div>
          {error && <p role="alert" className="answer-error">{error}</p>}
          {q.progress && <aside className={`feedback ${q.progress.correct ? 'success' : 'error'}`} aria-live="polite"><div className="feedback-title"><div className="feedback-outcome"><span aria-hidden="true">{q.progress.correct ? '✓' : '×'}</span><strong>{q.progress.correct ? 'Верно' : `Неверно · правильный ответ ${q.progress.correct_letter}`}</strong></div><button className="feedback-help-button" aria-label="Открыть объяснение" onClick={() => setHelpOpen(true)}>?</button></div></aside>}
          {done === total && <p className="topic-completed">{reviewParent ? 'Работа над ошибками завершена' : topic.kind === 'new' ? 'Новые вопросы пройдены' : 'Тема пройдена'}. Верно: {correct} из {total}. Можно вернуться к списку тем.</p>}
          </div>
          </div>
          <footer className="question-navigation"><div className="controls topic-controls"><button className="secondary" disabled={position === 0 || busy} onClick={() => goTo(position - 1)}>← Предыдущий</button><NextQuestionButton key={q.id} label={finishReady ? reviewParent ? 'Завершить работу над ошибками' : topic.kind === 'new' ? 'Завершить новые вопросы' : 'Завершить тему' : 'Следующий вопрос →'} disabled={busy || ((filteredRun || lastQuestion) && !q.progress)} imageUrl={topic.questions[nextPosition]?.image_url} onNext={() => finishReady ? onFinish(q.id) : goTo(nextPosition)} /></div>
          <button className="return-link" type="button" disabled={busy} onClick={onBack}><span className="return-arrow" aria-hidden="true">↩</span><span className="return-text">Вернуться</span></button></footer>
        </div>
      </section>
    </main>
    {helpOpen && <Modal eyebrow={`${topic.title} · вопрос ${position + 1}`} title="Объяснение" onClose={() => setHelpOpen(false)}><div className="help-languages">{(['ru', 'es', 'en'] as HelpLanguage[]).map((lang) => <button key={lang} onClick={() => setLanguage(lang)} className={language === lang ? 'active' : ''}>{lang.toUpperCase()}</button>)}</div><HelpContent text={help || 'Объяснение отсутствует в источнике.'} /></Modal>}
  </>;
}

function readInitialTicket() { const route = readRoute(); return route.screen === 'ticket' ? route.id : undefined; }

function TrainerApp() {
  const questionPanelRef = useRef<HTMLDivElement>(null);
  const [knowledge, setKnowledge] = useState<QuestionKnowledge>({});
  const [freshRepeat, setFreshRepeat] = useState(false);
  const [testId, setTestId] = useState(1015);
  const { route, navigate } = useTrainingNavigation();
  const home = route.screen === 'home';
  const setHome = (value: boolean) => navigate(value ? { screen: 'home' } : { screen: 'ticket', id: testId });
  const [libraryView, setLibraryView] = useState<LibraryView>(() => window.history.state?.libraryView ?? { search: '', expanded: [], scrollTop: 0, collection: null });
  const rememberLibrary = (snapshot: LibraryView) => {
    window.history.replaceState({ ...window.history.state, libraryView: snapshot }, '');
    setLibraryView(snapshot);
  };
  useEffect(() => {
    const restoreLibrary = (event: PopStateEvent) => { if (event.state?.libraryView) setLibraryView(event.state.libraryView); };
    window.addEventListener('popstate', restoreLibrary);
    return () => window.removeEventListener('popstate', restoreLibrary);
  }, []);
  const activeTopic = route.screen === 'topic' ? route : null;
  const setActiveTopic = (value: ({ id: string; question?: string } & TopicLaunch) | null) => navigate(value ? { screen: 'topic', ...value } : { screen: 'home' });
  const onTopicQuestion = useCallback((question: string, replace = false, runId?: number) => {
    if (route.screen === 'topic') navigate({ ...route, question, runId: runId ?? route.runId }, replace);
  }, [route, navigate]);
  const [library, setLibrary] = useState<LibraryData | null>(null);
  const pendingQuestion = useRef<number | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [savedProgress, setSavedProgress] = useState<ProgressStore>(() => readProgress());
  const [test, setTest] = useState<TestRecord | null>(null);
  const [translations, setTranslations] = useState<HelpTranslations | null>(null);
  const [loadError, setLoadError] = useState('');
  const [order, setOrder] = useState<number[]>([]);
  const [position, setPosition] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [mistakes, setMistakes] = useState<number[]>([]);
  const [finished, setFinished] = useState(false);
  const [roundMode, setRoundMode] = useState<RoundMode>('full');
  const [ticketAnswered, setTicketAnswered] = useState(0);
  const [ticketCorrect, setTicketCorrect] = useState(0);
  const [ticketWrong, setTicketWrong] = useState(0);
  const [attemptId, setAttemptId] = useState(() => createAttemptId());
  const [attemptStartedAt, setAttemptStartedAt] = useState(() => new Date().toISOString());
  const [attemptAnswers, setAttemptAnswers] = useState<AnswerHistory>({});
  const [attemptHistory, setAttemptHistory] = useState<AttemptHistory[]>([]);
  const [attemptReady, setAttemptReady] = useState(false);
  const [helpLanguage, setHelpLanguage] = useState<HelpLanguage>('ru');
  const [helpOpen, setHelpOpen] = useState(false);
  const [statisticsOpen, setStatisticsOpen] = useState(false);
  const [mobileHint, setMobileHint] = useState('');
  const [serverAttemptId, setServerAttemptId] = useState<string | null>(null);
  const [correctLetters, setCorrectLetters] = useState<Record<string, string>>({});
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [answerError, setAnswerError] = useState('');
  const [serverStatistics, setServerStatistics] = useState<AttemptHistory[] | null>(null);
  const [serverProgress, setServerProgress] = useState<Record<string, TicketStats>>({});
  const [initialTestReady, setInitialTestReady] = useState(false);

  useEffect(() => {
    if (route.screen !== 'ticket' || !initialTestReady) return;
    // Synchronize the existing ticket engine with browser navigation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (route.id !== testId) { pendingQuestion.current = route.index ?? null; setTestId(route.id); setTest(null); setAttemptReady(false); return; }
    if (!test || test.test_id !== route.id || !order.length) { pendingQuestion.current = route.index ?? null; return; }
    if (route.index === undefined) { navigate({ ...route, index: order[position] }, true); return; }
    const target = order.indexOf(route.index);
    if (target >= 0) { setPosition(target); setSelected(null); setHelpOpen(false); setStatisticsOpen(false); setFinished(false); }
  }, [route, initialTestReady, testId, test, order, position, navigate]);

  useEffect(() => {
    if (!home) return;
    let active=true;
    void api<QuestionKnowledge>('/api/questions/progress').then(data=>{if(active)setKnowledge(data);}).catch(()=>undefined);
    return ()=>{active=false;};
  },[home]);

  useEffect(() => {
    document.documentElement.classList.toggle('trainer-viewport', !home);
    return () => document.documentElement.classList.remove('trainer-viewport');
  }, [home]);

  useEffect(() => {
    let active = true;
    void fetch('/library.json').then((response) => { if (!response.ok) throw new Error('library'); return response.json(); }).then((data: LibraryData) => { if (active) setLibrary(data); }).catch(() => { if (active) setLoadError('Не удалось загрузить темы. Обновите страницу.'); });
    void Promise.all([
      api<CatalogEntry[]>('/api/catalog'),
      api<Record<string, TicketStats>>('/api/progress'),
    ]).then(([remoteCatalog, remoteProgress]) => {
      if (!active) return;
      const persisted = readProgress();
      setCatalog(remoteCatalog);
      setServerProgress(remoteProgress);
      setSavedProgress(persisted);
      setTestId(readInitialTicket() ?? chooseInitialTest(remoteCatalog, remoteProgress, persisted));
      setInitialTestReady(true);
    }).catch(() => {
      if (active) setLoadError('Не удалось загрузить прогресс. Обновите страницу.');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!initialTestReady) return;
    let active = true;
    async function loadTest() {
      try {
        const [loaded, remoteProgress, remoteCatalog, questionKnowledge] = await Promise.all([
          api<TestRecord>(`/api/tests/${testId}`),
          api<Record<string, TicketStats>>('/api/progress'),
          api<CatalogEntry[]>('/api/catalog'),
          api<QuestionKnowledge>('/api/questions/progress'),
        ]);
        if (!active) return;
        const persisted = readProgress();
        const saved = persisted[String(testId)];
        setTest(loaded);
        setKnowledge(questionKnowledge);
        setFreshRepeat(saved?.freshRepeat ?? false);
        setSavedProgress(persisted);
        setServerProgress(remoteProgress);
        setCatalog(remoteCatalog);
        setAttemptHistory(Array.isArray(saved?.history) ? saved.history : []);

        if (isValidProgress(saved, loaded.questions.length) && !saved.pendingRestart && saved.serverAttemptId) {
          const answers = deriveAnswers(saved);
          const normalizedOrder = saved.roundMode === 'mistakes'
            ? [...saved.order].sort((left, right) => left - right)
            : loaded.questions.map((_, index) => index);
          const firstUnanswered = normalizedOrder.findIndex((questionIndex) => !(String(questionIndex) in answers));
          setOrder(normalizedOrder);
          setPosition(saved.finished ? normalizedOrder.length - 1 : firstUnanswered >= 0 ? firstUnanswered : normalizedOrder.length - 1);
          setSelected(null);
          setScore(saved.score);
          setMistakes(saved.mistakes);
          setFinished(saved.finished);
          setRoundMode(saved.roundMode);
          setTicketAnswered(saved.ticketAnswered);
          setTicketCorrect(
            Number.isInteger(saved.ticketCorrect)
              ? saved.ticketCorrect!
              : saved.roundMode === 'full' ? saved.score : 0,
          );
          setTicketWrong(
            Number.isInteger(saved.ticketWrong)
              ? saved.ticketWrong!
              : saved.roundMode === 'full' ? saved.mistakes.length : 0,
          );
          setAttemptId(saved.attemptId ?? createAttemptId());
          setAttemptStartedAt(saved.startedAt ?? saved.updatedAt);
          setAttemptAnswers(answers);
          setServerAttemptId(saved.serverAttemptId ?? null);
          setCorrectLetters(saved.correctLetters ?? {});
        } else {
          setOrder(loaded.questions.map((_, index) => index));
          setPosition(0);
          setSelected(null);
          setScore(0);
          setMistakes([]);
          setFinished(false);
          setRoundMode('full');
          setTicketAnswered(0);
          setTicketCorrect(0);
          setTicketWrong(0);
          setAttemptId(createAttemptId());
          setAttemptStartedAt(new Date().toISOString());
          setAttemptAnswers({});
          setServerAttemptId(null);
          setCorrectLetters({});
        }
        if (pendingQuestion.current !== null) {
          const target = pendingQuestion.current;
          // Keep the existing round when possible; start a full round if a topic question is outside a mistakes round.
          if (saved?.roundMode === 'mistakes' && !saved.order.includes(target)) {
            setOrder(loaded.questions.map((_, index) => index));
            setRoundMode('full');
            setServerAttemptId(null);
            setAttemptAnswers({});
            setCorrectLetters({});
            setScore(0);
            setMistakes([]);
            setPosition(target);
          } else {
            setPosition(saved?.roundMode === 'mistakes' ? [...saved.order].sort((a, b) => a - b).indexOf(target) : target);
          }
          setFinished(false);
          pendingQuestion.current = null;
        }
        setHelpOpen(false);
        setStatisticsOpen(false);
        setMobileHint('');
        setAnswerError('');
        setServerStatistics(null);
        setAttemptReady(true);
        setTranslations(loaded.translations ?? null);
      } catch (error) {
        if (import.meta.env.DEV) console.error('Ticket load failed', error);
        if (active) setLoadError('Не удалось загрузить билет. Обновите страницу.');
      }
    }

    loadTest();
    return () => { active = false; };
  }, [initialTestReady, testId]);

  useEffect(() => {
    if (!attemptReady || !test || !order.length) return;

    const progress: SavedProgress = {
      order,
      position,
      selected,
      score,
      mistakes,
      finished,
      roundMode,
      ticketAnswered,
      ticketCorrect,
      ticketWrong,
      attemptId,
      startedAt: attemptStartedAt,
      answers: attemptAnswers,
      history: attemptHistory,
      pendingRestart: false,
      freshRepeat,
      serverAttemptId,
      correctLetters,
      updatedAt: new Date().toISOString(),
    };

    writeProgress({ ...readProgress(), [String(testId)]: progress });
  }, [attemptAnswers, attemptHistory, attemptId, attemptReady, attemptStartedAt, correctLetters, finished, freshRepeat, mistakes, order, position, roundMode, score, selected, serverAttemptId, test, testId, ticketAnswered, ticketCorrect, ticketWrong]);

  useEffect(() => {
    questionPanelRef.current?.scrollTo({ top: 0 });
    questionPanelRef.current?.parentElement?.scrollTo({ top: 0 });
  }, [position, roundMode, testId]);

  function selectTest(nextTestId: number, index?: number) {
    navigate({ screen: 'ticket', id: nextTestId, index });
    const entry = catalog.find((item) => item.id === nextTestId);
    setAttemptReady(false);
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
    setRoundMode('full');
    setTicketAnswered(0);
    setTicketCorrect(0);
    setTicketWrong(0);
    setAttemptAnswers({});
    setServerAttemptId(null);
    setCorrectLetters({});
    setAnswerError('');
    setServerStatistics(null);
    setHelpOpen(false);
    setStatisticsOpen(false);
    setMobileHint('');
    setHelpLanguage(entry?.translated ? 'ru' : 'en');
  }

  const questions = test?.questions ?? [];
  const questionIndex = order[position] ?? 0;
  const question = questions[questionIndex];
  const inherited = !freshRepeat && roundMode === 'full' && question?.canonical_id ? knowledge[question.canonical_id] : undefined;
  const isAnswered = (index: number) => String(index) in attemptAnswers || (!freshRepeat && roundMode === 'full' && !!knowledge[questions[index]?.canonical_id ?? '']);
  const answered = selected !== null || isAnswered(questionIndex);
  const selectedIsCorrect = inherited?.correct ?? attemptAnswers[String(questionIndex)] ?? false;
  const sameText = (a: string, b: string) => a.toLowerCase().replace(/\s+/g,' ').trim() === b.toLowerCase().replace(/\s+/g,' ').trim();
  const correctLetter = correctLetters[String(questionIndex)] ?? question?.answers.find(a=>inherited && sameText(a.text,inherited.correct_text))?.letter;
  const selectedLetter = selected ?? question?.answers.find(a=>inherited && sameText(a.text,inherited.selected_text))?.letter;
  const hasNextQuestion = position < order.length-1 || order.some((index)=>!isAnswered(index));
  const progress = order.length ? Math.round(order.filter(isAnswered).length / order.length * 100) : 0;

  async function chooseAnswer(letter: string) {
    if (answered || submittingAnswer) return;
    setSubmittingAnswer(true);
    setAnswerError('');
    try {
      let activeAttempt = serverAttemptId;
      if (!activeAttempt) {
        const created = await api<{ id: string }>('/api/attempts', {
          method: 'POST',
          body: JSON.stringify({ test_id: testId, mode: roundMode, total: order.length }),
        });
        activeAttempt = created.id;
        setServerAttemptId(created.id);
      }
      const result = await api<{ correct: boolean; correct_letter: string }>(`/api/attempts/${activeAttempt}/answers`, {
        method: 'POST',
        body: JSON.stringify({ question: questionIndex + 1, selected_letter: letter }),
      });
      setSelected(letter);
      if (question.canonical_id && roundMode === 'full') setKnowledge(current=>({...current,[question.canonical_id!]:{selected_text:question.answers.find(a=>a.letter===letter)!.text,correct_text:question.answers.find(a=>a.letter===result.correct_letter)!.text,correct:result.correct,answered_at:new Date().toISOString()}}));
      setCorrectLetters((current) => ({ ...current, [String(questionIndex)]: result.correct_letter }));
      setAttemptAnswers((current) => ({ ...current, [String(questionIndex)]: result.correct }));
      if (roundMode === 'full') setTicketAnswered(Math.min(Object.keys(attemptAnswers).length + 1, questions.length));
      if (result.correct) {
        setScore((value) => value + 1);
        if (roundMode === 'full') setTicketCorrect((value) => value + 1);
      } else {
        setMistakes((items) => items.includes(questionIndex) ? items : [...items, questionIndex]);
        if (roundMode === 'full') setTicketWrong((value) => value + 1);
      }
      if (roundMode === 'full') {
        setServerProgress((current) => {
          const previous = current[String(testId)] ?? { answered: 0, correct: 0, wrong: 0 };
          return { ...current, [String(testId)]: { answered: previous.answered + 1, correct: previous.correct + (result.correct ? 1 : 0), wrong: previous.wrong + (result.correct ? 0 : 1) } };
        });
      }
    } catch (requestError) {
      setAnswerError(requestError instanceof Error ? requestError.message : 'Не удалось сохранить ответ');
    } finally {
      setSubmittingAnswer(false);
    }
  }

  function nextQuestionPosition() {
    const afterCurrent = order.findIndex((questionIndex, index) => index > position && !isAnswered(questionIndex));
    if (afterCurrent >= 0) return afterCurrent;
    const earlier = order.findIndex((questionIndex) => !isAnswered(questionIndex));
    return earlier >= 0 ? earlier : position < order.length-1 ? position+1 : -1;
  }

  function nextQuestion() {
    const nextPosition = nextQuestionPosition();
    if (nextPosition < 0) {
      if (!freshRepeat && roundMode === 'full') { if (serverAttemptId) void api(`/api/attempts/${serverAttemptId}/complete`, {method:'POST'}).catch(()=>undefined); setHome(true); return; }
      if (roundMode === 'full') setTicketAnswered(questions.length);
      setFinished(true);
      if (serverAttemptId) void api(`/api/attempts/${serverAttemptId}/complete`, { method: 'POST' }).catch(() => undefined);
      return;
    }
    navigate({ screen: 'ticket', id: testId, index: order[nextPosition] });
    setSelected(null);
    setHelpOpen(false);
  }

  function startRound(nextOrder: number[], mode: RoundMode = 'full') {
    setFreshRepeat(true);
    navigate({ screen: 'ticket', id: testId, index: nextOrder[0] });
    const archived = makeAttemptHistory({
      attemptId,
      startedAt: attemptStartedAt,
      updatedAt: new Date().toISOString(),
      finished,
      roundMode,
      order,
      answers: attemptAnswers,
      position,
      selected,
      mistakes,
    });
    setAttemptHistory((current) => appendAttempt(current, archived));
    setOrder([...nextOrder].sort((left, right) => left - right));
    setPosition(0);
    setSelected(null);
    setScore(0);
    setMistakes([]);
    setFinished(false);
    setRoundMode(mode);
    setAttemptId(createAttemptId());
    setAttemptStartedAt(new Date().toISOString());
    setAttemptAnswers({});
    if (serverAttemptId && Object.keys(attemptAnswers).length) void api(`/api/attempts/${serverAttemptId}/complete`, { method: 'POST' }).catch(() => undefined);
    setServerAttemptId(null);
    setCorrectLetters({});
    setAnswerError('');
    setServerStatistics(null);
    setHelpOpen(false);
    setStatisticsOpen(false);
    setMobileHint('');
    if (mode === 'full') {
      setTicketAnswered(0);
      setTicketCorrect(0);
      setTicketWrong(0);
    }
  }

  function resetTicketProgress(resetTestId: number) {
    if (resetTestId === testId) {
      startRound(questions.map((_, index) => index));
      return;
    }

    const next = readProgress();
    const saved = next[String(resetTestId)];
    if (!saved) return;
    const history = appendAttempt(saved.history ?? [], makeAttemptHistory(saved));
    next[String(resetTestId)] = {
      ...saved,
      selected: null,
      score: 0,
      mistakes: [],
      finished: false,
      roundMode: 'full',
      ticketAnswered: 0,
      ticketCorrect: 0,
      ticketWrong: 0,
      attemptId: createAttemptId(),
      startedAt: new Date().toISOString(),
      answers: {},
      history,
      pendingRestart: true,
      freshRepeat: true,
      serverAttemptId: null,
      correctLetters: {},
      updatedAt: new Date().toISOString(),
    };
    writeProgress(next);
    setSavedProgress(next);
  }

  function getTicketStats(entry: CatalogEntry): TicketStats {
    if (library) {
      const records=library.questions.filter(q=>q.verified && q.test_id===entry.id);
      const covered=records.map(q=>knowledge[q.canonical_id]).filter(Boolean);
      return {total:records.length,answered:covered.length,correct:covered.filter(q=>q.correct).length,wrong:covered.filter(q=>!q.correct).length,completed:records.length>0&&covered.length===records.length};
    }
    if (entry.id === testId && attemptReady && ticketAnswered > 0) {
      return { answered: ticketAnswered, correct: ticketCorrect, wrong: ticketWrong };
    }

    const remote = serverProgress[String(entry.id)];
    if (remote?.answered) return remote;

    const saved = savedProgress[String(entry.id)];
    if (!saved) return { answered: 0, correct: 0, wrong: 0 };
    if (!saved.pendingRestart && saved.ticketAnswered > 0) {
      return {
        answered: saved.ticketAnswered,
        correct: saved.ticketCorrect ?? (saved.roundMode === 'full' ? saved.score : 0),
        wrong: saved.ticketWrong ?? (saved.roundMode === 'full' ? saved.mistakes.length : 0),
      };
    }

    const previous = saved.history?.at(-1);
    if (previous) return { answered: previous.answered, correct: previous.correct, wrong: previous.wrong };
    return { answered: 0, correct: 0, wrong: 0 };
  }

  function showMobileHint(message: string) {
    setMobileHint((current) => current === message ? '' : message);
  }

  function openStatistics() {
    setMobileHint('');
    setStatisticsOpen(true);
    setServerStatistics(null);
    void api<{ attempts: AttemptHistory[] }>(`/api/tests/${testId}/statistics`)
      .then((response) => setServerStatistics(response.attempts))
      .catch(() => setServerStatistics([]));
  }

  function openLibraryQuestion(id: number, index?: number) {
    navigate({ screen: 'ticket', id, index });
    if (id === testId && test) {
      if (index !== undefined) {
        const existingPosition = order.indexOf(index);
        if (existingPosition >= 0) { setPosition(existingPosition); setSelected(null); setFinished(false); }
        else { startRound(questions.map((_, i) => i)); setPosition(index); }
      }
    } else {
      pendingQuestion.current = index ?? null;
      selectTest(id, index);
    }
  }

  if (loadError) return <main className="loading error-message">{loadError}</main>;
  if (activeTopic && library) {
    const node = library.nodes.find((item) => item.id === activeTopic.id);
    const ancestors: string[] = [];
    let parent = node?.parent_id;
    while (parent) { const ancestor = library.nodes.find((item) => item.id === parent); if (!ancestor) break; ancestors.unshift(ancestor.label_ru); parent = ancestor.parent_id; }
    return <TopicTrainer key={`${activeTopic.id}:${activeTopic.reviewParent ?? (activeTopic.newQuestions ? 'new' : 'full')}`} newQuestions={activeTopic.newQuestions} runId={activeTopic.runId} topicId={activeTopic.id} initialQuestion={activeTopic.question} reviewParent={activeTopic.reviewParent} path={ancestors.join(' / ')} onQuestion={onTopicQuestion} sectionNavigation={<SectionNavigator library={library} catalog={catalog} getStats={getTicketStats} sectionId={node?.parent_id ?? activeTopic.id} onOpenTopic={(id, question, options) => setActiveTopic({ id, question, ...options })} />} onBack={() => { setActiveTopic(null); setHome(true); }} onFinish={(question) => {
      const expanded = [activeTopic.id];
      let parentId = node?.parent_id;
      while (parentId) {
        expanded.push(parentId);
        parentId = library.nodes.find((item) => item.id === parentId)?.parent_id;
      }
      setLibraryView((current) => ({ ...current, search: '', collection: null, expanded: [...new Set([...current.expanded, ...expanded])], completedTopic: { id: activeTopic.id, question } }));
      setActiveTopic(null);
      setHome(true);
    }} />;
  }
  if (home && catalog.length && library) return <QuestionLibrary view={libraryView} knowledge={knowledge} onRemember={rememberLibrary} catalog={catalog} library={library} onOpen={openLibraryQuestion} onOpenTopic={(id, question, options) => { setActiveTopic({ id, question, ...options }); }} getStats={getTicketStats} />;
  if (home || !test || !question || !order.length || !catalog.length) return <PageLoader />;

  const currentEntry = catalog.find((entry) => entry.id === testId) ?? catalog[0];
  const currentStats = getTicketStats(currentEntry);
  const mobileStatusBar = (
    <MobileStatusBar
      testId={testId}
      entries={catalog}
      stats={currentStats}
      total={questions.length}
      hint={mobileHint}
      getStats={getTicketStats}
      onSelect={(nextTestId) => {
        if (nextTestId !== testId) selectTest(nextTestId);
      }}
      onRestart={resetTicketProgress}
      onHint={showMobileHint}
      onStatistics={openStatistics}
    />
  );
  const statisticsModal = statisticsOpen && (
    <Modal
      eyebrow={`Test ${sourceTicket(test.test_id)}`}
      title="Статистика билета"
      className="statistics-modal"
      onClose={() => setStatisticsOpen(false)}
    >
      {serverStatistics === null
        ? <div className="statistics-loading">Загружаем статистику…</div>
        : <StatisticsContent attempts={serverStatistics} questions={questions} />}
    </Modal>
  );

  if (finished) {
    const percent = Math.round((score / order.length) * 100);
    return (
      <>
        {mobileStatusBar}
        <button className="library-back" type="button" onClick={() => setHome(true)}>‹ Панель обучения</button>
        <main className="result-page">
        <section className="result-card">
          <p className="eyebrow">Test {sourceTicket(test.test_id)} · раунд завершён</p>
          <div className="result-ring" style={{ '--score': `${percent * 3.6}deg` } as React.CSSProperties}>
            <strong>{score}/{order.length}</strong><span>{percent}%</span>
          </div>
          <h1>{percent >= 90 ? 'Отличный результат' : percent >= 70 ? 'Хорошая работа' : 'Продолжим тренировку'}</h1>
          <p>Ошибок: {mistakes.length}. Билет можно пройти ещё раз.</p>
          <TicketMenu
            value={testId}
            entries={catalog}
            getStats={getTicketStats}
            onSelect={(nextTestId) => {
              if (nextTestId !== testId) selectTest(nextTestId);
            }}
            onRestart={resetTicketProgress}
          />
          <div className="result-actions">
            <button className="secondary result-statistics-button" onClick={openStatistics}><StatsGlyph /> Статистика</button>
            {mistakes.length > 0 && <button className="primary" onClick={() => startRound(mistakes, 'mistakes')}>Повторить ошибки</button>}
            <button className="secondary" onClick={() => startRound(questions.map((_, index) => index))}>Новый раунд</button>
          </div>
        </section>
        </main>
        {statisticsModal}
      </>
    );
  }

  const helpText =
    translations?.help[String(questionIndex + 1)]?.[helpLanguage] ??
    question.help;

  return (
    <>
      {mobileStatusBar}
        <button className="library-back" type="button" onClick={() => setHome(true)}>‹ Панель обучения</button>
      <main className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <p className="eyebrow">{collectionName(test.collection)} · {sourceTicket(test.test_id)}</p>
          <h1 title={ticketTitle({ id: testId, title: test.title })}>{ticketTitle({ id: testId, title: test.title })}</h1>
        </div>
        <div className="header-tools">
          <TicketMenu
            value={testId}
            entries={catalog}
            getStats={getTicketStats}
            onSelect={(nextTestId) => {
              if (nextTestId !== testId) selectTest(nextTestId);
            }}
            onRestart={resetTicketProgress}
          />
          <div className="ticket-progress" aria-label={`Пройдено ${currentStats.answered} из ${questions.length}`}>
            <span>Пройдено</span><strong>{currentStats.answered}/{questions.length}</strong>
          </div>
          <div className="answer-stats">
            <div className="score" aria-label={`Верно ${currentStats.correct}`}><span>Верно</span><strong>{currentStats.correct}</strong></div>
            <div className="score score-wrong" aria-label={`Неверно ${currentStats.wrong}`}><span>Неверно</span><strong>{currentStats.wrong}</strong></div>
          </div>
          <button type="button" className="statistics-button" aria-label="Статистика билета" title="Статистика билета" onClick={openStatistics}><StatsGlyph /></button>
        </div>
      </header>

      <div className="progress-row">
        <span>Вопрос {position + 1} из {order.length}</span>
        <div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
        <span>{progress}%</span>
      </div>

      <section className="quiz-card">
        <div className="visual-panel">
          <div className="question-number">#{question.number.replace(/\.$/, '')}</div>
          <div className="visual-media">
            {question.image_url ? <img
              src={question.image_url}
              alt={`Иллюстрация к вопросу ${question.number}`}
            /> : <span className="visual-empty">Вопрос без иллюстрации</span>}
          </div>
        </div>

        <div className="question-panel fixed-question-layout">
          <div className="question-content">
          <div className="question-heading-row">
            <h2><BilingualText text={question.question} /></h2>
          </div>
          <div className="answer-scroll" ref={questionPanelRef}><div className="answers">
            {question.answers.map((answer) => {
              const state = answered
                ? answer.letter === correctLetter
                  ? 'correct'
                  : answer.letter === selectedLetter
                    ? 'wrong'
                    : 'muted'
                : '';
              return (
                <button
                  key={answer.letter}
                  className={`answer ${state}`}
                  onClick={() => chooseAnswer(answer.letter)}
                  disabled={answered || submittingAnswer}
                >
                  <span className="answer-letter">{answer.letter}</span>
                  <BilingualText text={answer.text} />
                </button>
              );
            })}
          </div>

          {answerError && <p className="answer-error" role="alert">{answerError}</p>}

          {answered && (
            <aside className={`feedback ${selectedIsCorrect ? 'success' : 'error'}`} aria-live="polite">
              <div className="feedback-title">
                <div className="feedback-outcome">
                  <span aria-hidden="true">{selectedIsCorrect ? '✓' : '×'}</span>
                  <strong>{selectedIsCorrect ? 'Верно' : `Неверно · правильный ответ ${correctLetter}`}</strong>
                </div>
                <button type="button" className="feedback-help-button" aria-label="Открыть объяснение" title="Ayuda · объяснение" onClick={() => setHelpOpen(true)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 10.8v6" />
                    <path d="M12 7.4h.01" />
                  </svg>
                </button>
              </div>
            </aside>
          )}

          </div>
          </div>
          <footer className="question-navigation"><div className="controls">
            <button className="shuffle-button" onClick={() => resetTicketProgress(testId)}>↻ Начать заново</button>
            <NextQuestionButton key={`${testId}:${questionIndex}:${roundMode}`} disabled={!answered || submittingAnswer}
              label={`${hasNextQuestion ? 'Следующий вопрос' : freshRepeat ? 'Результат' : 'Завершить билет'} →`}
              imageUrl={questions[order[nextQuestionPosition()]]?.image_url} onNext={nextQuestion} />
          </div></footer>
        </div>
      </section>
      </main>

      {helpOpen && (
        <Modal
          eyebrow={`Test ${sourceTicket(test.test_id)} · вопрос ${question.number}`}
          title="Ayuda · объяснение"
          className="help-modal"
          onClose={() => setHelpOpen(false)}
        >
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
        </Modal>
      )}
      {statisticsModal}
    </>
  );
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    api<AuthUser>('/api/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
  }, []);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setUser(null);
  }

  if (checkingSession) return <PageLoader />;
  if (!user) return <LoginScreen onAuthenticated={setUser} />;
  return <><AccountMenu key={`account:${user.id}`} user={user} onLogout={logout} /><MigrationGate key={user.id} user={user} onLogout={logout} /></>;
}
