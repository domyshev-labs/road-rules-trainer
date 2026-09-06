package app

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/mail"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/resend/resend-go/v3"
)

const sessionCookie = "rrt_session"

type App struct {
	cfg    Config
	db     *sql.DB
	logger *slog.Logger
	email  EmailSender
	mux    *http.ServeMux
}

type user struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type contextKey string

const userContextKey contextKey = "user"

func New(cfg Config, logger *slog.Logger) (*App, error) {
	db, err := openDatabase(cfg.DatabasePath)
	if err != nil {
		return nil, err
	}
	var sender EmailSender = logEmailSender{logger: logger}
	if cfg.EmailMode == "resend" {
		sender = resendEmailSender{client: resend.NewClient(cfg.ResendAPIKey), from: cfg.EmailFrom}
	}
	application := &App{cfg: cfg, db: db, logger: logger, email: sender, mux: http.NewServeMux()}
	application.routes()
	return application, nil
}

func (app *App) Close() error { return app.db.Close() }

func (app *App) Handler() http.Handler {
	return app.recoverPanic(app.securityHeaders(app.logRequests(app.mux)))
}

func (app *App) routes() {
	app.mux.HandleFunc("GET /api/health", app.health)
	app.mux.HandleFunc("POST /api/auth/request-code", app.requestCode)
	app.mux.HandleFunc("POST /api/auth/verify-code", app.verifyCode)
	app.mux.Handle("GET /api/auth/me", app.requireUser(http.HandlerFunc(app.me)))
	app.mux.Handle("POST /api/auth/logout", app.requireUser(http.HandlerFunc(app.logout)))
	app.mux.Handle("GET /api/catalog", app.requireUser(http.HandlerFunc(app.catalog)))
	app.mux.Handle("GET /api/tests/{testID}", app.requireUser(http.HandlerFunc(app.test)))
	app.mux.Handle("POST /api/attempts", app.requireUser(http.HandlerFunc(app.createAttempt)))
	app.mux.Handle("POST /api/attempts/{attemptID}/answers", app.requireUser(http.HandlerFunc(app.answerQuestion)))
	app.mux.Handle("POST /api/attempts/{attemptID}/complete", app.requireUser(http.HandlerFunc(app.completeAttempt)))
	app.mux.Handle("GET /api/tests/{testID}/statistics", app.requireUser(http.HandlerFunc(app.statistics)))
	app.mux.Handle("GET /api/progress", app.requireUser(http.HandlerFunc(app.progress)))
	app.mux.Handle("POST /api/progress/import", app.requireUser(http.HandlerFunc(app.importProgress)))

	static := app.cfg.StaticDir
	if info, err := os.Stat(static); err == nil && info.IsDir() {
		files := http.FileServer(http.Dir(static))
		app.mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			path := filepath.Join(static, filepath.Clean(r.URL.Path))
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				files.ServeHTTP(w, r)
				return
			}
			http.ServeFile(w, r, filepath.Join(static, "index.html"))
		})
	}
}

func (app *App) health(w http.ResponseWriter, _ *http.Request) {
	if err := app.db.Ping(); err != nil {
		app.writeError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	app.writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (app *App) requestCode(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email string `json:"email"`
	}
	if !app.decodeJSON(w, r, &input) {
		return
	}
	email, err := normalizeEmail(input.Email)
	if err != nil {
		app.writeError(w, http.StatusUnprocessableEntity, "Введите корректный email")
		return
	}
	now := time.Now().UTC()
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	var recent int
	if err := app.db.QueryRow(`SELECT count(*) FROM login_codes WHERE email=? AND created_at>?`, email, now.Add(-time.Hour).Format(time.RFC3339Nano)).Scan(&recent); err != nil {
		app.serverError(w, err)
		return
	}
	if recent >= 5 {
		app.writeError(w, http.StatusTooManyRequests, "Слишком много запросов. Попробуйте позже")
		return
	}
	if err := app.db.QueryRow(`SELECT count(*) FROM login_codes WHERE request_ip=? AND created_at>?`, ip, now.Add(-time.Hour).Format(time.RFC3339Nano)).Scan(&recent); err != nil {
		app.serverError(w, err)
		return
	}
	if recent >= 20 {
		app.writeError(w, http.StatusTooManyRequests, "Слишком много запросов. Попробуйте позже")
		return
	}
	var lastCreated string
	err = app.db.QueryRow(`SELECT created_at FROM login_codes WHERE email=? ORDER BY created_at DESC LIMIT 1`, email).Scan(&lastCreated)
	if err == nil {
		if parsed, parseErr := time.Parse(time.RFC3339Nano, lastCreated); parseErr == nil && now.Sub(parsed) < time.Minute {
			app.writeError(w, http.StatusTooManyRequests, "Новый код можно запросить через минуту")
			return
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		app.serverError(w, err)
		return
	}

	code, err := randomDigits(6)
	if err != nil {
		app.serverError(w, err)
		return
	}
	id, _ := randomToken(18)
	if _, err := app.db.Exec(`INSERT INTO login_codes(id,email,code_hash,request_ip,expires_at,created_at) VALUES(?,?,?,?,?,?)`, id, email, app.codeHash(email, code), ip, now.Add(10*time.Minute).Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		app.serverError(w, err)
		return
	}
	if err := app.email.SendLoginCode(r.Context(), email, code); err != nil {
		_, _ = app.db.Exec(`UPDATE login_codes SET consumed_at=? WHERE id=?`, now.Format(time.RFC3339Nano), id)
		app.logger.Error("send login code", "email", email, "error", err)
		app.writeError(w, http.StatusBadGateway, "Не удалось отправить письмо")
		return
	}
	app.writeJSON(w, http.StatusAccepted, map[string]string{"message": "Код отправлен"})
}

func (app *App) verifyCode(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if !app.decodeJSON(w, r, &input) {
		return
	}
	email, err := normalizeEmail(input.Email)
	if err != nil || len(input.Code) != 6 {
		app.writeError(w, http.StatusUnauthorized, "Неверный или просроченный код")
		return
	}
	var id, hash, expires string
	var attempts int
	err = app.db.QueryRow(`SELECT id,code_hash,expires_at,attempts FROM login_codes WHERE email=? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, email).Scan(&id, &hash, &expires, &attempts)
	if err != nil {
		app.writeError(w, http.StatusUnauthorized, "Неверный или просроченный код")
		return
	}
	expiresAt, parseErr := time.Parse(time.RFC3339Nano, expires)
	if parseErr != nil || time.Now().UTC().After(expiresAt) || attempts >= 5 || !hmac.Equal([]byte(hash), []byte(app.codeHash(email, input.Code))) {
		_, _ = app.db.Exec(`UPDATE login_codes SET attempts=attempts+1 WHERE id=?`, id)
		app.writeError(w, http.StatusUnauthorized, "Неверный или просроченный код")
		return
	}

	now := time.Now().UTC()
	userID, _ := randomToken(18)
	tx, err := app.db.Begin()
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO users(id,email,created_at) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING`, userID, email, now.Format(time.RFC3339Nano)); err != nil {
		app.serverError(w, err)
		return
	}
	var current user
	if err = tx.QueryRow(`SELECT id,email FROM users WHERE email=?`, email).Scan(&current.ID, &current.Email); err != nil {
		app.serverError(w, err)
		return
	}
	token, _ := randomToken(32)
	if _, err = tx.Exec(`INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)`, tokenHash(token), current.ID, now.Add(30*24*time.Hour).Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		app.serverError(w, err)
		return
	}
	if _, err = tx.Exec(`UPDATE login_codes SET consumed_at=? WHERE id=?`, now.Format(time.RFC3339Nano), id); err != nil {
		app.serverError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		app.serverError(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: token, Path: "/", HttpOnly: true, Secure: app.cfg.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: 30 * 24 * 60 * 60})
	app.writeJSON(w, http.StatusOK, current)
}

func (app *App) me(w http.ResponseWriter, r *http.Request) {
	app.writeJSON(w, http.StatusOK, r.Context().Value(userContextKey).(user))
}

func (app *App) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		_, _ = app.db.Exec(`DELETE FROM sessions WHERE token_hash=?`, tokenHash(cookie.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", HttpOnly: true, Secure: app.cfg.CookieSecure, SameSite: http.SameSiteLaxMode, MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

func (app *App) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookie)
		if err != nil {
			app.writeError(w, http.StatusUnauthorized, "Требуется вход")
			return
		}
		var current user
		var expires string
		err = app.db.QueryRow(`SELECT users.id,users.email,sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?`, tokenHash(cookie.Value)).Scan(&current.ID, &current.Email, &expires)
		expiresAt, parseErr := time.Parse(time.RFC3339Nano, expires)
		if err != nil || parseErr != nil || time.Now().UTC().After(expiresAt) {
			app.writeError(w, http.StatusUnauthorized, "Сессия истекла")
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, current)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (app *App) catalog(w http.ResponseWriter, _ *http.Request) {
	rows, err := app.db.Query(`SELECT id,title,question_count FROM tests ORDER BY id`)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer rows.Close()
	items := make([]map[string]any, 0, 33)
	for rows.Next() {
		var id, count int
		var title string
		if err := rows.Scan(&id, &title, &count); err != nil {
			app.serverError(w, err)
			return
		}
		items = append(items, map[string]any{"id": id, "title": title, "questions": count, "translated": true})
	}
	app.writeJSON(w, http.StatusOK, items)
}

func (app *App) test(w http.ResponseWriter, r *http.Request) {
	testID, err := strconv.Atoi(r.PathValue("testID"))
	if err != nil {
		app.writeError(w, http.StatusBadRequest, "Некорректный билет")
		return
	}
	var title string
	if err := app.db.QueryRow(`SELECT title FROM tests WHERE id=?`, testID).Scan(&title); err != nil {
		app.writeError(w, http.StatusNotFound, "Билет не найден")
		return
	}
	rows, err := app.db.Query(`SELECT q.id,q.ordinal,q.number,q.prompt,q.help_en,q.help_es,q.help_ru,q.image_path,a.letter,a.text FROM questions q JOIN answers a ON a.question_id=q.id WHERE q.test_id=? ORDER BY q.ordinal,a.letter`, testID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer rows.Close()
	questions := make([]map[string]any, 0)
	translations := make(map[string]map[string]string)
	var currentOrdinal int
	var currentQuestion map[string]any
	for rows.Next() {
		var id, ordinal int
		var number, prompt, en, es, ru, image, letter, answerText string
		if err := rows.Scan(&id, &ordinal, &number, &prompt, &en, &es, &ru, &image, &letter, &answerText); err != nil {
			app.serverError(w, err)
			return
		}
		if ordinal != currentOrdinal {
			currentOrdinal = ordinal
			currentQuestion = map[string]any{"number": number, "question": prompt, "answers": make([]map[string]string, 0, 3), "help": en, "image_url": image, "local_image": image}
			questions = append(questions, currentQuestion)
			translations[strconv.Itoa(ordinal)] = map[string]string{"en": en, "es": es, "ru": ru}
		}
		answers := currentQuestion["answers"].([]map[string]string)
		currentQuestion["answers"] = append(answers, map[string]string{"letter": letter, "text": answerText})
	}
	app.writeJSON(w, http.StatusOK, map[string]any{"test_id": testID, "title": title, "questions": questions, "translations": map[string]any{"help": translations}})
}

func (app *App) createAttempt(w http.ResponseWriter, r *http.Request) {
	current := r.Context().Value(userContextKey).(user)
	var input struct {
		TestID int    `json:"test_id"`
		Mode   string `json:"mode"`
		Total  int    `json:"total"`
	}
	if !app.decodeJSON(w, r, &input) {
		return
	}
	if input.Mode != "full" && input.Mode != "mistakes" {
		app.writeError(w, http.StatusUnprocessableEntity, "Некорректный режим")
		return
	}
	var count int
	if err := app.db.QueryRow(`SELECT question_count FROM tests WHERE id=?`, input.TestID).Scan(&count); err != nil {
		app.writeError(w, http.StatusNotFound, "Билет не найден")
		return
	}
	if input.Total <= 0 || input.Total > count {
		input.Total = count
	}
	id, _ := randomToken(18)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := app.db.Exec(`INSERT INTO attempts(id,user_id,test_id,mode,total,started_at) VALUES(?,?,?,?,?,?)`, id, current.ID, input.TestID, input.Mode, input.Total, now); err != nil {
		app.serverError(w, err)
		return
	}
	app.writeJSON(w, http.StatusCreated, map[string]string{"id": id, "started_at": now})
}

func (app *App) answerQuestion(w http.ResponseWriter, r *http.Request) {
	current := r.Context().Value(userContextKey).(user)
	attemptID := r.PathValue("attemptID")
	var input struct {
		Question       int    `json:"question"`
		SelectedLetter string `json:"selected_letter"`
	}
	if !app.decodeJSON(w, r, &input) {
		return
	}
	input.SelectedLetter = strings.ToUpper(strings.TrimSpace(input.SelectedLetter))
	var questionID int
	var correctLetter string
	err := app.db.QueryRow(`SELECT q.id,a.letter FROM attempts at JOIN questions q ON q.test_id=at.test_id JOIN answers a ON a.question_id=q.id AND a.correct=1 WHERE at.id=? AND at.user_id=? AND q.ordinal=? AND at.completed_at IS NULL`, attemptID, current.ID, input.Question).Scan(&questionID, &correctLetter)
	if err != nil {
		app.writeError(w, http.StatusNotFound, "Попытка или вопрос не найдены")
		return
	}
	var valid int
	if err := app.db.QueryRow(`SELECT count(*) FROM answers WHERE question_id=? AND letter=?`, questionID, input.SelectedLetter).Scan(&valid); err != nil || valid == 0 {
		app.writeError(w, http.StatusUnprocessableEntity, "Некорректный вариант ответа")
		return
	}
	isCorrect := input.SelectedLetter == correctLetter
	result, err := app.db.Exec(`INSERT INTO attempt_answers(attempt_id,question_id,selected_letter,correct,answered_at) VALUES(?,?,?,?,?) ON CONFLICT(attempt_id,question_id) DO NOTHING`, attemptID, questionID, input.SelectedLetter, isCorrect, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		app.serverError(w, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		app.writeError(w, http.StatusConflict, "На этот вопрос уже дан ответ")
		return
	}
	app.writeJSON(w, http.StatusOK, map[string]any{"correct": isCorrect, "correct_letter": correctLetter})
}

func (app *App) completeAttempt(w http.ResponseWriter, r *http.Request) {
	current := r.Context().Value(userContextKey).(user)
	result, err := app.db.Exec(`UPDATE attempts SET completed_at=? WHERE id=? AND user_id=? AND completed_at IS NULL`, time.Now().UTC().Format(time.RFC3339Nano), r.PathValue("attemptID"), current.ID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		app.writeError(w, http.StatusNotFound, "Попытка не найдена")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (app *App) statistics(w http.ResponseWriter, r *http.Request) {
	current := r.Context().Value(userContextKey).(user)
	testID, err := strconv.Atoi(r.PathValue("testID"))
	if err != nil {
		app.writeError(w, 400, "Некорректный билет")
		return
	}
	type attemptStatistics struct {
		ID        string          `json:"id"`
		Mode      string          `json:"mode"`
		Total     int             `json:"total"`
		StartedAt string          `json:"startedAt"`
		EndedAt   string          `json:"endedAt"`
		Completed bool            `json:"completed"`
		Answered  int             `json:"answered"`
		Correct   int             `json:"correct"`
		Wrong     int             `json:"wrong"`
		Answers   map[string]bool `json:"answers"`
	}
	rows, err := app.db.Query(`SELECT at.id,at.mode,at.total,at.started_at,at.completed_at,count(aa.question_id),coalesce(sum(aa.correct),0) FROM attempts at LEFT JOIN attempt_answers aa ON aa.attempt_id=at.id WHERE at.user_id=? AND at.test_id=? GROUP BY at.id ORDER BY at.started_at`, current.ID, testID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer rows.Close()
	attempts := make([]attemptStatistics, 0)
	attemptByID := make(map[string]*attemptStatistics)
	for rows.Next() {
		var id, mode, started string
		var completed sql.NullString
		var total, answered, correct int
		if err := rows.Scan(&id, &mode, &total, &started, &completed, &answered, &correct); err != nil {
			app.serverError(w, err)
			return
		}
		endedAt := completed.String
		if endedAt == "" {
			endedAt = started
		}
		attempts = append(attempts, attemptStatistics{ID: id, Mode: mode, Total: total, StartedAt: started, EndedAt: endedAt, Completed: completed.Valid, Answered: answered, Correct: correct, Wrong: answered - correct, Answers: make(map[string]bool)})
	}
	rows.Close()
	for index := range attempts {
		attemptByID[attempts[index].ID] = &attempts[index]
	}
	answerRows, err := app.db.Query(`SELECT aa.attempt_id,q.ordinal,aa.correct FROM attempt_answers aa JOIN attempts at ON at.id=aa.attempt_id JOIN questions q ON q.id=aa.question_id WHERE at.user_id=? AND at.test_id=?`, current.ID, testID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	for answerRows.Next() {
		var attemptID string
		var ordinal int
		var correct bool
		if err := answerRows.Scan(&attemptID, &ordinal, &correct); err != nil {
			answerRows.Close()
			app.serverError(w, err)
			return
		}
		if attempt := attemptByID[attemptID]; attempt != nil {
			attempt.Answers[strconv.Itoa(ordinal-1)] = correct
		}
	}
	answerRows.Close()
	questionRows, err := app.db.Query(`SELECT q.ordinal,count(aa.question_id),coalesce(sum(aa.correct),0) FROM questions q LEFT JOIN attempt_answers aa ON aa.question_id=q.id AND EXISTS(SELECT 1 FROM attempts own WHERE own.id=aa.attempt_id AND own.user_id=?) WHERE q.test_id=? GROUP BY q.id ORDER BY q.ordinal`, current.ID, testID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer questionRows.Close()
	questions := make([]map[string]int, 0)
	for questionRows.Next() {
		var ordinal, answered, correct int
		if err := questionRows.Scan(&ordinal, &answered, &correct); err != nil {
			app.serverError(w, err)
			return
		}
		questions = append(questions, map[string]int{"question": ordinal, "answered": answered, "correct": correct, "wrong": answered - correct})
	}
	app.writeJSON(w, http.StatusOK, map[string]any{"attempts": attempts, "questions": questions})
}

func (app *App) progress(w http.ResponseWriter, r *http.Request) {
	current := r.Context().Value(userContextKey).(user)
	rows, err := app.db.Query(`SELECT at.test_id,count(aa.question_id),coalesce(sum(aa.correct),0) FROM attempts at LEFT JOIN attempt_answers aa ON aa.attempt_id=at.id WHERE at.user_id=? AND at.started_at=(SELECT max(newest.started_at) FROM attempts newest WHERE newest.user_id=at.user_id AND newest.test_id=at.test_id) GROUP BY at.id`, current.ID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer rows.Close()
	items := make(map[string]map[string]int)
	for rows.Next() {
		var id, answered, correct int
		if err := rows.Scan(&id, &answered, &correct); err != nil {
			app.serverError(w, err)
			return
		}
		items[strconv.Itoa(id)] = map[string]int{"answered": answered, "correct": correct, "wrong": answered - correct}
	}
	app.writeJSON(w, http.StatusOK, items)
}

func (app *App) importProgress(w http.ResponseWriter, r *http.Request) {
	current := r.Context().Value(userContextKey).(user)
	type importedAttempt struct {
		SourceID  string          `json:"source_id"`
		TestID    int             `json:"test_id"`
		Mode      string          `json:"mode"`
		Total     int             `json:"total"`
		StartedAt string          `json:"started_at"`
		EndedAt   string          `json:"ended_at"`
		Completed bool            `json:"completed"`
		Answers   map[string]bool `json:"answers"`
	}
	var input struct {
		Attempts []importedAttempt `json:"attempts"`
	}
	if !app.decodeJSON(w, r, &input) {
		return
	}
	if len(input.Attempts) > 500 {
		app.writeError(w, http.StatusRequestEntityTooLarge, "Слишком много попыток для импорта")
		return
	}
	tx, err := app.db.Begin()
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer tx.Rollback()
	imported := 0
	for _, attempt := range input.Attempts {
		if attempt.SourceID == "" || len(attempt.SourceID) > 160 || (attempt.Mode != "full" && attempt.Mode != "mistakes") || len(attempt.Answers) > 100 {
			continue
		}
		var testCount int
		if err := tx.QueryRow(`SELECT question_count FROM tests WHERE id=?`, attempt.TestID).Scan(&testCount); err != nil {
			continue
		}
		if attempt.Total <= 0 || attempt.Total > testCount {
			attempt.Total = testCount
		}
		startedAt, startErr := time.Parse(time.RFC3339Nano, attempt.StartedAt)
		endedAt, endErr := time.Parse(time.RFC3339Nano, attempt.EndedAt)
		if startErr != nil {
			continue
		}
		if endErr != nil {
			endedAt = startedAt
		}
		id, _ := randomToken(18)
		var completed any
		if attempt.Completed {
			completed = endedAt.Format(time.RFC3339Nano)
		}
		result, err := tx.Exec(`INSERT INTO attempts(id,source_id,user_id,test_id,mode,total,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,source_id) DO NOTHING`, id, attempt.SourceID, current.ID, attempt.TestID, attempt.Mode, attempt.Total, startedAt.Format(time.RFC3339Nano), completed)
		if err != nil {
			app.serverError(w, err)
			return
		}
		affected, _ := result.RowsAffected()
		if affected == 0 {
			continue
		}
		imported++
		for questionKey, correct := range attempt.Answers {
			zeroBased, parseErr := strconv.Atoi(questionKey)
			if parseErr != nil || zeroBased < 0 || zeroBased >= testCount {
				continue
			}
			var questionID int
			var correctLetter string
			if err := tx.QueryRow(`SELECT q.id,a.letter FROM questions q JOIN answers a ON a.question_id=q.id AND a.correct=1 WHERE q.test_id=? AND q.ordinal=?`, attempt.TestID, zeroBased+1).Scan(&questionID, &correctLetter); err != nil {
				continue
			}
			selected := "?"
			if correct {
				selected = correctLetter
			}
			_, err = tx.Exec(`INSERT INTO attempt_answers(attempt_id,question_id,selected_letter,correct,answered_at) VALUES(?,?,?,?,?)`, id, questionID, selected, correct, endedAt.Format(time.RFC3339Nano))
			if err != nil {
				app.serverError(w, err)
				return
			}
		}
	}
	if err := tx.Commit(); err != nil {
		app.serverError(w, err)
		return
	}
	app.writeJSON(w, http.StatusOK, map[string]int{"imported": imported})
}

func normalizeEmail(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(value)
	if err != nil || parsed.Address != value || len(value) > 254 {
		return "", errors.New("invalid email")
	}
	return value, nil
}

func randomDigits(length int) (string, error) {
	digits := make([]byte, length)
	for index := range digits {
		value, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		digits[index] = '0' + byte(value.Int64())
	}
	return string(digits), nil
}

func randomToken(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (app *App) codeHash(email, code string) string {
	mac := hmac.New(sha256.New, []byte(app.cfg.SessionSecret))
	mac.Write([]byte(email + ":" + code))
	return hex.EncodeToString(mac.Sum(nil))
}

func (app *App) decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		app.writeError(w, http.StatusUnsupportedMediaType, "Требуется JSON")
		return false
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		app.writeError(w, http.StatusBadRequest, "Некорректный JSON")
		return false
	}
	return true
}
func (app *App) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (app *App) writeError(w http.ResponseWriter, status int, message string) {
	app.writeJSON(w, status, map[string]string{"error": message})
}
func (app *App) serverError(w http.ResponseWriter, err error) {
	app.logger.Error("request failed", "error", err)
	app.writeError(w, http.StatusInternalServerError, "Внутренняя ошибка сервера")
}

func (app *App) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}
func (app *App) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		app.logger.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started).String())
	})
}
func (app *App) recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if value := recover(); value != nil {
				app.logger.Error("panic", "value", fmt.Sprint(value))
				app.writeError(w, 500, "Внутренняя ошибка сервера")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
