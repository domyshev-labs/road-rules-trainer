import { useEffect, useMemo, useState } from 'react';

type Answer = { letter: string; text: string; correct?: boolean };
type Question = {
  number: string;
  question: string;
  answers: Answer[];
  help: string;
  image_url: string | null;
  local_image: string | null;
};
type TestRecord = { test_id: number; title: string; questions: Question[]; translations?: HelpTranslations };
type AuthUser = { id: string; email: string };
type CatalogEntry = { id: number; title: string; questions: number; translated: boolean };
type HelpLanguage = 'ru' | 'es' | 'en';
type HelpTranslations = { help: Record<string, Record<HelpLanguage, string>> };
type RoundMode = 'full' | 'mistakes';
type AnswerHistory = Record<string, boolean>;
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
  serverAttemptId?: string | null;
  correctLetters?: Record<string, string>;
  updatedAt: string;
};
type ProgressStore = Record<string, SavedProgress>;
type TicketStats = { answered: number; correct: number; wrong: number };

const progressStorageKey = 'road-rules-trainer-progress-v1';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    credentials: 'same-origin',
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

function StatisticsContent({ attempts, questionCount }: { attempts: AttemptHistory[]; questionCount: number }) {
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
            <article className={item.attempts ? '' : 'empty'} key={item.question}>
              <strong>#{item.question}</strong>
              <span>{item.attempts ? `${item.attempts} отв.` : '—'}</span>
              <span className="attempt-correct">👍 {item.correct}</span>
              <span className="attempt-wrong">👎 {item.wrong}</span>
            </article>
          ))}
        </div>
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
  const activeStats = getStats(active);

  return (
    <div className="ticket-menu-shell">
      <button
        type="button"
        className="ticket-menu-trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="ticket-menu-trigger-copy">
          <span className="ticket-menu-trigger-label">Билет</span>
          <span className="ticket-menu-trigger-title" title={active.title}>
            <strong>{active.id}</strong><i>—</i><span>{active.title}</span>
          </span>
        </span>
        <span className="ticket-menu-trigger-progress">{activeStats.answered}/{active.questions}</span>
        <span className="ticket-menu-chevron" aria-hidden="true">⌄</span>
      </button>

      {open && (
        <>
          <button className="ticket-menu-backdrop" type="button" aria-label="Закрыть список билетов" onClick={() => setOpen(false)} />
          <section className="ticket-menu-panel" aria-label="Список билетов">
            <header>
              <div>
                <p>Билеты</p>
                <strong>Выберите билет или начните его заново</strong>
              </div>
              <button type="button" aria-label="Закрыть" onClick={() => setOpen(false)}>×</button>
            </header>
            <div className="ticket-menu-list">
              {entries.map((entry) => {
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
                      <span className="ticket-menu-number">{entry.id}</span>
                      <span className="ticket-menu-title">{entry.title}</span>
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
  user,
  onLogout,
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
  user: AuthUser;
  onLogout: () => void;
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
      <button type="button" className="mobile-account-button" aria-label={`Выйти из ${user.email}`} title={user.email} onClick={onLogout}>⇥</button>
      {hint && <output className="mobile-status-hint">{hint}</output>}
    </nav>
  );
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

function TrainerApp({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [testId, setTestId] = useState(1015);
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
  const [migrationReady, setMigrationReady] = useState(() => Object.values(readProgress()).every((progress) => {
    return !(progress.history?.length) && makeAttemptHistory(progress) === null;
  }));

  useEffect(() => {
    const batches = Object.entries(readProgress()).map(([storedTestID, progress]) => {
      const current = makeAttemptHistory(progress);
      const attempts = appendAttempt(progress.history ?? [], current).map((attempt) => ({
        source_id: `${storedTestID}:${attempt.id}`,
        test_id: Number(storedTestID),
        mode: attempt.mode,
        total: attempt.total,
        started_at: attempt.startedAt,
        ended_at: attempt.endedAt,
        completed: attempt.completed,
        answers: attempt.answers,
      }));
      return attempts;
    });
    if (!batches.some((attempts) => attempts.length)) {
      return;
    }
    void Promise.all(batches.filter((attempts) => attempts.length).map((attempts) => (
      api('/api/progress/import', { method: 'POST', body: JSON.stringify({ attempts }) })
    )))
      .then(() => api<Record<string, TicketStats>>('/api/progress'))
      .then(setServerProgress)
      .catch(() => undefined)
      .finally(() => setMigrationReady(true));
  }, [user.id]);

  useEffect(() => {
    if (!migrationReady) return;
    let active = true;
    async function loadTest() {
      try {
        const [loaded, remoteProgress, remoteCatalog] = await Promise.all([
          api<TestRecord>(`/api/tests/${testId}`),
          api<Record<string, TicketStats>>('/api/progress'),
          api<CatalogEntry[]>('/api/catalog'),
        ]);
        if (!active) return;
        const persisted = readProgress();
        const saved = persisted[String(testId)];
        setTest(loaded);
        setSavedProgress(persisted);
        setServerProgress(remoteProgress);
        setCatalog(remoteCatalog);
        setAttemptHistory(Array.isArray(saved?.history) ? saved.history : []);

        if (isValidProgress(saved, loaded.questions.length) && !saved.pendingRestart && saved.serverAttemptId) {
          setOrder(saved.order);
          setPosition(saved.position);
          setSelected(saved.selected);
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
          setAttemptAnswers(deriveAnswers(saved));
          setServerAttemptId(saved.serverAttemptId ?? null);
          setCorrectLetters(saved.correctLetters ?? {});
        } else {
          setOrder(shuffle(loaded.questions.map((_, index) => index)));
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
        setHelpOpen(false);
        setStatisticsOpen(false);
        setMobileHint('');
        setAnswerError('');
        setServerStatistics(null);
        setAttemptReady(true);
        setTranslations(loaded.translations ?? null);
      } catch {
        if (active) setLoadError('Не удалось загрузить билет. Обновите страницу.');
      }
    }

    loadTest();
    return () => { active = false; };
  }, [migrationReady, testId]);

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
      serverAttemptId,
      correctLetters,
      updatedAt: new Date().toISOString(),
    };

    writeProgress({ ...readProgress(), [String(testId)]: progress });
  }, [attemptAnswers, attemptHistory, attemptId, attemptReady, attemptStartedAt, correctLetters, finished, mistakes, order, position, roundMode, score, selected, serverAttemptId, test, testId, ticketAnswered, ticketCorrect, ticketWrong]);

  function selectTest(nextTestId: number) {
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
  const answered = selected !== null;
  const selectedIsCorrect = attemptAnswers[String(questionIndex)] ?? false;
  const correctLetter = correctLetters[String(questionIndex)];
  const progress = useMemo(
    () => order.length ? Math.round(((position + (answered ? 1 : 0)) / order.length) * 100) : 0,
    [answered, order.length, position],
  );

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
      setCorrectLetters((current) => ({ ...current, [String(questionIndex)]: result.correct_letter }));
      setAttemptAnswers((current) => ({ ...current, [String(questionIndex)]: result.correct }));
      if (roundMode === 'full') setTicketAnswered(Math.min(position + 1, questions.length));
      if (result.correct) {
        setScore((value) => value + 1);
        if (roundMode === 'full') setTicketCorrect((value) => value + 1);
      } else {
        setMistakes((items) => items.includes(questionIndex) ? items : [...items, questionIndex]);
        if (roundMode === 'full') setTicketWrong((value) => value + 1);
      }
      setServerProgress((current) => {
        const previous = current[String(testId)] ?? { answered: 0, correct: 0, wrong: 0 };
        return { ...current, [String(testId)]: { answered: previous.answered + 1, correct: previous.correct + (result.correct ? 1 : 0), wrong: previous.wrong + (result.correct ? 0 : 1) } };
      });
    } catch (requestError) {
      setAnswerError(requestError instanceof Error ? requestError.message : 'Не удалось сохранить ответ');
    } finally {
      setSubmittingAnswer(false);
    }
  }

  function nextQuestion() {
    if (position >= order.length - 1) {
      if (roundMode === 'full') setTicketAnswered(questions.length);
      setFinished(true);
      if (serverAttemptId) void api(`/api/attempts/${serverAttemptId}/complete`, { method: 'POST' }).catch(() => undefined);
      return;
    }
    setPosition((value) => value + 1);
    setSelected(null);
    setHelpOpen(false);
  }

  function startRound(nextOrder: number[], mode: RoundMode = 'full') {
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
    setOrder(shuffle(nextOrder));
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
      serverAttemptId: null,
      correctLetters: {},
      updatedAt: new Date().toISOString(),
    };
    writeProgress(next);
    setSavedProgress(next);
  }

  function getTicketStats(entry: CatalogEntry): TicketStats {
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

  if (loadError) return <main className="loading error-message">{loadError}</main>;
  if (!test || !question || !order.length || !catalog.length) return <main className="loading">Загружаем билет…</main>;

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
      user={user}
      onLogout={onLogout}
    />
  );
  const statisticsModal = statisticsOpen && (
    <Modal
      eyebrow={`Test ${test.test_id}`}
      title="Статистика билета"
      className="statistics-modal"
      onClose={() => setStatisticsOpen(false)}
    >
      {serverStatistics === null
        ? <div className="statistics-loading">Загружаем статистику…</div>
        : <StatisticsContent attempts={serverStatistics} questionCount={questions.length} />}
    </Modal>
  );

  if (finished) {
    const percent = Math.round((score / order.length) * 100);
    return (
      <>
        {mobileStatusBar}
        <main className="result-page">
        <section className="result-card">
          <p className="eyebrow">Test {test.test_id} · раунд завершён</p>
          <div className="result-ring" style={{ '--score': `${percent * 3.6}deg` } as React.CSSProperties}>
            <strong>{score}/{order.length}</strong><span>{percent}%</span>
          </div>
          <h1>{percent >= 90 ? 'Отличный результат' : percent >= 70 ? 'Хорошая работа' : 'Продолжим тренировку'}</h1>
          <p>Ошибок: {mistakes.length}. Вопросы можно пройти заново в другом порядке.</p>
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
      <main className="app-shell">
      <header className="topbar">
        <div className="title-block">
          <p className="eyebrow">Thematic Test {test.test_id}</p>
          <h1 title={test.title}>{test.title}</h1>
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
          <button type="button" className="account-button" aria-label="Выйти" title={`${user.email} · выйти`} onClick={onLogout}>⇥</button>
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
          <div className="question-heading-row">
            <h2><BilingualText text={question.question} /></h2>
            <button type="button" className="help-button" aria-label="Открыть объяснение" title="Ayuda · объяснение" onClick={() => setHelpOpen(true)}>?</button>
          </div>
          <div className="answers">
            {question.answers.map((answer) => {
              const state = answered
                ? answer.letter === correctLetter
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
                <strong>{selectedIsCorrect ? 'Верно' : `Неверно · правильный ответ ${correctLetter}`}</strong>
                <span>{selectedIsCorrect ? '✓' : '!'}</span>
              </div>
            </aside>
          )}

          <div className="controls">
            <button className="shuffle-button" onClick={() => resetTicketProgress(testId)}>↻ Начать заново</button>
            <button className="primary next" onClick={nextQuestion} disabled={!answered}>
              {position === order.length - 1 ? 'Результат' : 'Следующий вопрос'} →
            </button>
          </div>
        </div>
      </section>
      </main>

      {helpOpen && (
        <Modal
          eyebrow={`Test ${test.test_id} · вопрос ${questionIndex + 1}`}
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

  if (checkingSession) return <main className="loading">Проверяем сессию…</main>;
  if (!user) return <LoginScreen onAuthenticated={setUser} />;
  return <TrainerApp user={user} onLogout={logout} />;
}
