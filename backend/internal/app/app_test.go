package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type capturedEmail struct {
	email string
	code  string
}

func (sender *capturedEmail) SendLoginCode(_ context.Context, email, code string) error {
	sender.email = email
	sender.code = code
	return nil
}

func newTestApp(t *testing.T) (*App, *capturedEmail) {
	t.Helper()
	application, err := New(Config{
		Address:       ":0",
		DatabasePath:  t.TempDir() + "/trainer.db",
		StaticDir:     t.TempDir(),
		SessionSecret: "test-secret-with-more-than-24-characters",
		EmailMode:     "log",
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = application.Close() })
	sender := &capturedEmail{}
	application.email = sender
	return application, sender
}

func request(t *testing.T, handler http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

func TestPasswordlessQuizFlow(t *testing.T) {
	application, sender := newTestApp(t)
	handler := application.Handler()
	var questionCount int
	if err := application.db.QueryRow(`SELECT count(*) FROM questions`).Scan(&questionCount); err != nil || questionCount != 956 {
		t.Fatalf("seeded questions: count=%d error=%v", questionCount, err)
	}

	response := request(t, handler, http.MethodPost, "/api/auth/request-code", `{"email":"Driver@Example.com"}`, nil)
	if response.Code != http.StatusAccepted || sender.email != "driver@example.com" || len(sender.code) != 6 {
		t.Fatalf("request code: status=%d email=%q code=%q body=%s", response.Code, sender.email, sender.code, response.Body.String())
	}

	response = request(t, handler, http.MethodPost, "/api/auth/verify-code", `{"email":"driver@example.com","code":"`+sender.code+`"}`, nil)
	if response.Code != http.StatusOK || len(response.Result().Cookies()) != 1 {
		t.Fatalf("verify code: status=%d body=%s", response.Code, response.Body.String())
	}
	cookie := response.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.Name != sessionCookie {
		t.Fatalf("session cookie is not hardened: %#v", cookie)
	}

	response = request(t, handler, http.MethodGet, "/api/catalog", "", cookie)
	var catalog []map[string]any
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &catalog) != nil || len(catalog) != 33 {
		t.Fatalf("catalog: status=%d count=%d body=%s", response.Code, len(catalog), response.Body.String())
	}

	response = request(t, handler, http.MethodGet, "/api/tests/1015", "", cookie)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"correct"`) {
		t.Fatalf("test response leaked correct answers: status=%d", response.Code)
	}

	response = request(t, handler, http.MethodPost, "/api/attempts", `{"test_id":1015,"mode":"full","total":18}`, cookie)
	var attempt struct {
		ID string `json:"id"`
	}
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &attempt) != nil || attempt.ID == "" {
		t.Fatalf("create attempt: status=%d body=%s", response.Code, response.Body.String())
	}

	response = request(t, handler, http.MethodPost, "/api/attempts/"+attempt.ID+"/answers", `{"question":1,"selected_letter":"A"}`, cookie)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"correct":false`) || !strings.Contains(response.Body.String(), `"correct_letter":"C"`) {
		t.Fatalf("answer: status=%d body=%s", response.Code, response.Body.String())
	}

	response = request(t, handler, http.MethodGet, "/api/tests/1015/statistics", "", cookie)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"wrong":1`) || !strings.Contains(response.Body.String(), `"answers":{"0":false}`) {
		t.Fatalf("statistics: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestProtectedRoutesRequireSession(t *testing.T) {
	application, _ := newTestApp(t)
	response := request(t, application.Handler(), http.MethodGet, "/api/catalog", "", nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", response.Code)
	}
}
