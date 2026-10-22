package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/domyshev-labs/road-rules-trainer/backend/seed"
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

func expectedSeedCounts(t *testing.T) (int, int) {
	t.Helper()
	entries, err := seed.Files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	tickets, questions := 0, 0
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "test-") || strings.HasSuffix(entry.Name(), "-help.json") {
			continue
		}
		data, err := seed.Files.ReadFile(entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		var ticket seedTest
		if err := json.Unmarshal(data, &ticket); err != nil {
			t.Fatal(err)
		}
		tickets++
		questions += len(ticket.Questions)
	}
	return tickets, questions
}

func TestPasswordlessQuizFlow(t *testing.T) {
	expectedTickets, expectedQuestions := expectedSeedCounts(t)
	application, sender := newTestApp(t)
	handler := application.Handler()
	var questionCount int
	if err := application.db.QueryRow(`SELECT count(*) FROM questions`).Scan(&questionCount); err != nil || questionCount != expectedQuestions {
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
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &catalog) != nil || len(catalog) != expectedTickets {
		t.Fatalf("catalog: status=%d count=%d body=%s", response.Code, len(catalog), response.Body.String())
	}
	for _, ticket := range catalog {
		if ticket["collection"] != "Thematic Test" && ticket["collection"] != "Exam Test" {
			t.Fatalf("unexpected ticket collection: %#v", ticket)
		}
	}

	response = request(t, handler, http.MethodGet, "/api/tests/1015", "", cookie)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"correct"`) {
		t.Fatalf("test response leaked correct answers: status=%d", response.Code)
	}
	var ticket struct {
		Collection string `json:"collection"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &ticket); err != nil || ticket.Collection != "Thematic Test" {
		t.Fatalf("ticket collection: %q error=%v", ticket.Collection, err)
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
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"wrong":1`) || !strings.Contains(response.Body.String(), `"answers":{"0":false}`) || !strings.Contains(response.Body.String(), `"selectedLetter":"A"`) || !strings.Contains(response.Body.String(), `"correctLetter":"C"`) {
		t.Fatalf("statistics: status=%d body=%s", response.Code, response.Body.String())
	}

	response = request(t, handler, http.MethodPost, "/api/attempts", `{"test_id":1015,"mode":"mistakes","total":1}`, cookie)
	var correctionAttempt struct {
		ID string `json:"id"`
	}
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &correctionAttempt) != nil || correctionAttempt.ID == "" {
		t.Fatalf("create correction attempt: status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(t, handler, http.MethodPost, "/api/attempts/"+correctionAttempt.ID+"/answers", `{"question":1,"selected_letter":"C"}`, cookie)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"correct":true`) {
		t.Fatalf("correction answer: status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(t, handler, http.MethodGet, "/api/tests/1015/statistics", "", cookie)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"mode":"mistakes"`) || !strings.Contains(response.Body.String(), `"answered":1,"correct":0,"wrong":1`) {
		t.Fatalf("correction attempt leaked into statistics: status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(t, handler, http.MethodGet, "/api/progress", "", cookie)
	var progress map[string]struct {
		Answered  int    `json:"answered"`
		Correct   int    `json:"correct"`
		Wrong     int    `json:"wrong"`
		Total     int    `json:"total"`
		StartedAt string `json:"startedAt"`
		Completed bool   `json:"completed"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &progress) != nil {
		t.Fatalf("progress after correction: status=%d body=%s", response.Code, response.Body.String())
	}
	if got := progress["1015"]; got.Answered != 1 || got.Correct != 0 || got.Wrong != 1 || got.Total != 18 || got.StartedAt == "" || got.Completed {
		t.Fatalf("correction attempt changed progress: %#v", got)
	}

	legacyImport := `{"attempts":[{"source_id":"1015:legacy-attempt","test_id":1015,"mode":"full","total":18,"started_at":"2026-09-01T10:00:00Z","ended_at":"2026-09-01T10:05:00Z","completed":false,"answers":{"0":true,"1":false}}]}`
	response = request(t, handler, http.MethodPost, "/api/progress/import", legacyImport, cookie)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"imported":1`) {
		t.Fatalf("legacy import: status=%d body=%s", response.Code, response.Body.String())
	}
	response = request(t, handler, http.MethodPost, "/api/progress/import", legacyImport, cookie)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"imported":0`) {
		t.Fatalf("idempotent legacy import: status=%d body=%s", response.Code, response.Body.String())
	}
	var importedAttempts, importedAnswers int
	if err := application.db.QueryRow(`SELECT count(*) FROM attempts WHERE source_id='1015:legacy-attempt'`).Scan(&importedAttempts); err != nil {
		t.Fatal(err)
	}
	if err := application.db.QueryRow(`SELECT count(*) FROM attempt_answers aa JOIN attempts a ON a.id=aa.attempt_id WHERE a.source_id='1015:legacy-attempt'`).Scan(&importedAnswers); err != nil {
		t.Fatal(err)
	}
	if importedAttempts != 1 || importedAnswers != 2 {
		t.Fatalf("imported legacy data: attempts=%d answers=%d", importedAttempts, importedAnswers)
	}
}

func TestProtectedRoutesRequireSession(t *testing.T) {
	application, _ := newTestApp(t)
	response := request(t, application.Handler(), http.MethodGet, "/api/catalog", "", nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", response.Code)
	}
}

func TestLegacyCollectionMigrationPreservesAnswers(t *testing.T) {
	path := t.TempDir() + "/legacy.db"
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacySchema := strings.Replace(schema, "  collection TEXT NOT NULL CHECK(collection IN ('Thematic Test','Exam Test')),\n", "", 1)
	if _, err := db.Exec(legacySchema); err != nil {
		db.Close()
		t.Fatal(err)
	}
	_, err = db.Exec(`
INSERT INTO tests(id,title,question_count) VALUES(1001,'Definitions',30);
INSERT INTO questions(id,test_id,ordinal,number,prompt,help_en,help_es,help_ru,image_path)
VALUES(987654,1001,1,'1','Legacy prompt','','','','');
INSERT INTO users(id,email,created_at) VALUES('legacy-user','legacy@example.com','2026-10-20T00:00:00Z');
INSERT INTO attempts(id,user_id,test_id,mode,total,started_at)
VALUES('legacy-attempt','legacy-user',1001,'full',30,'2026-10-20T00:00:00Z');
INSERT INTO attempt_answers(attempt_id,question_id,selected_letter,correct,answered_at)
VALUES('legacy-attempt',987654,'A',1,'2026-10-20T00:00:01Z');`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	// Reopening twice also verifies that the migration and seed remain idempotent.
	for range 2 {
		upgraded, err := openDatabase(path)
		if err != nil {
			t.Fatal(err)
		}
		var count int
		err = upgraded.QueryRow(`SELECT count(*) FROM attempt_answers aa JOIN questions q ON q.id=aa.question_id JOIN tests t ON t.id=q.test_id WHERE aa.attempt_id='legacy-attempt' AND q.id=987654 AND t.collection='Thematic Test' AND aa.selected_letter='A' AND aa.correct=1`).Scan(&count)
		upgraded.Close()
		if err != nil || count != 1 {
			t.Fatalf("legacy answer after migration: count=%d error=%v", count, err)
		}
	}
}

func TestSharedQuestionsAndExamMemberships(t *testing.T) {
	application, _ := newTestApp(t)
	var thematic, exam string
	if err := application.db.QueryRow(`SELECT m.content_id FROM question_memberships m JOIN questions q ON q.id=m.question_id WHERE q.test_id=1023 AND q.ordinal=1`).Scan(&thematic); err != nil {
		t.Fatal(err)
	}
	// Source question 8 has training ordinal 7 because source question 5 is deferred.
	if err := application.db.QueryRow(`SELECT m.content_id FROM question_memberships m JOIN questions q ON q.id=m.question_id WHERE q.test_id=101045 AND q.ordinal=7`).Scan(&exam); err != nil {
		t.Fatal(err)
	}
	if thematic != exam {
		t.Fatalf("shared question was duplicated: %s != %s", thematic, exam)
	}
	var sourceNumber, image string
	if err := application.db.QueryRow(`SELECT number,image_path FROM questions WHERE test_id=101045 AND ordinal=7`).Scan(&sourceNumber, &image); err != nil {
		t.Fatal(err)
	}
	if sourceNumber != "8." || image != "/tests/exam/1045/q08.jpg" {
		t.Fatalf("lost source position: %q %q", sourceNumber, image)
	}
	var count int
	if err := application.db.QueryRow(`SELECT count(*) FROM questions WHERE test_id=101045 AND number IN ('5.','16.','26.')`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("deferred questions imported: count=%d err=%v", count, err)
	}
	var optionalImage string
	if err := application.db.QueryRow(`SELECT image_path FROM questions WHERE test_id=101079 AND ordinal=6`).Scan(&optionalImage); err != nil || optionalImage != "" {
		t.Fatalf("text-only source question received a fabricated image: %q err=%v", optionalImage, err)
	}
	var incomplete int
	if err := application.db.QueryRow(`SELECT count(*) FROM questions q WHERE (SELECT count(*) FROM answers a WHERE a.question_id=q.id AND a.correct=1)<>1`).Scan(&incomplete); err != nil || incomplete != 0 {
		t.Fatalf("invalid answer keys: count=%d err=%v", incomplete, err)
	}
}

func TestTopicTrainingUsesUniqueMembersAndSeparateProgress(t *testing.T) {
	application, sender := newTestApp(t)
	handler := application.Handler()
	request(t, handler, http.MethodPost, "/api/auth/request-code", `{"email":"topic@example.com"}`, nil)
	login := request(t, handler, http.MethodPost, "/api/auth/verify-code", `{"email":"topic@example.com","code":"`+sender.code+`"}`, nil)
	if login.Code != http.StatusOK {
		t.Fatal(login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	response := request(t, handler, http.MethodGet, "/api/topics/routine.drugs", "", cookie)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"correct"`) {
		t.Fatalf("topic response leaked answer keys or failed: %s", response.Body.String())
	}
	var topic struct {
		Questions []topicQuestion `json:"questions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &topic); err != nil {
		t.Fatal(err)
	}
	if len(topic.Questions) < 2 {
		t.Fatal("expected multiple drug questions")
	}
	seen := map[string]bool{}
	for i, q := range topic.Questions {
		if q.QuestionRU == "" && q.Question == "" {
			t.Fatal("missing question list title and source prompt")
		}
		if q.Number != i+1 || seen[q.ID] {
			t.Fatalf("invalid topic numbering or duplicated content: %+v", q)
		}
		seen[q.ID] = true
	}
	_, members, all, err := topicMembers("routine.drugs")
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range all {
		if (ref.TestID == 101017 && ref.SourceOrdinal == 3) || (ref.TestID == 101020 && ref.SourceOrdinal == 6) || (ref.TestID == 101018 && ref.SourceOrdinal == 3) {
			if seen[ref.CanonicalID] {
				t.Fatalf("alcohol/fatigue question incorrectly classified as drugs: %+v", ref)
			}
		}
	}
	first, err := application.loadTopicQuestion(members[0])
	if err != nil {
		t.Fatal(err)
	}
	letter := ""
	for _, answer := range first.Answers {
		if answer.Correct {
			letter = answer.Letter
		}
	}
	body := `{"question_id":"` + first.ID + `","selected_letter":"` + letter + `"}`
	for i := 0; i < 2; i++ {
		response = request(t, handler, http.MethodPost, "/api/topics/routine.drugs/answers", body, cookie)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"correct":true`) {
			t.Fatalf("topic answer failed: %s", response.Body.String())
		}
	}
	var count int
	if err := application.db.QueryRow(`SELECT count(*) FROM topic_answers`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("topic answer is not idempotent: %d %v", count, err)
	}
	if err := application.db.QueryRow(`SELECT count(*) FROM attempt_answers`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("topic polluted source-ticket progress: %d %v", count, err)
	}
	response = request(t, handler, http.MethodGet, "/api/topics/routine.drugs", "", cookie)
	if !strings.Contains(response.Body.String(), `"selected_letter":"`+letter+`"`) {
		t.Fatal("topic progress was not restored")
	}
	response = request(t, handler, http.MethodPost, "/api/topics/routine.drugs/answers", `{"question_id":"not-a-member","selected_letter":"A"}`, cookie)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatal("accepted a question outside the topic")
	}
	response = request(t, handler, http.MethodGet, "/api/topics/routine", "", cookie)
	if response.Code != http.StatusNotFound {
		t.Fatal("parent topic should not create a separate training collection")
	}

	second, err := application.loadTopicQuestion(members[1])
	if err != nil {
		t.Fatal(err)
	}
	wrong := ""
	for _, answer := range second.Answers {
		if !answer.Correct {
			wrong = answer.Letter
			break
		}
	}
	response = request(t, handler, http.MethodPost, "/api/topics/routine.drugs/answers", `{"question_id":"`+second.ID+`","selected_letter":"`+wrong+`"}`, cookie)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	response = request(t, handler, http.MethodGet, "/api/topics/progress", "", cookie)
	var summaries map[string]struct {
		Total    int             `json:"total"`
		Answered int             `json:"answered"`
		Correct  int             `json:"correct"`
		Wrong    int             `json:"wrong"`
		Next     int             `json:"next_question"`
		Results  map[string]bool `json:"results"`
	}
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &summaries); err != nil {
		t.Fatal(err)
	}
	stats := summaries["routine.drugs"]
	if stats.Total != len(members) || stats.Answered != 2 || stats.Correct != 1 || stats.Wrong != 1 || stats.Next != 3 || !stats.Results[first.ID] || stats.Results[second.ID] {
		t.Fatalf("incorrect summary or resume position: %+v", stats)
	}
	_, alcoholMembers, _, e := topicMembers("routine.alcohol")
	if e != nil {
		t.Fatal(e)
	}
	expectedAlcohol := 0
	for _, ref := range alcoholMembers {
		if ref.CanonicalID == first.ID || ref.CanonicalID == second.ID {
			expectedAlcohol++
		}
	}
	if summaries["routine.alcohol"].Answered != expectedAlcohol {
		t.Fatal("shared-question progress did not follow canonical membership")
	}
	request(t, handler, http.MethodPost, "/api/auth/request-code", `{"email":"other-topic@example.com"}`, nil)
	other := request(t, handler, http.MethodPost, "/api/auth/verify-code", `{"email":"other-topic@example.com","code":"`+sender.code+`"}`, nil)
	isolated := request(t, handler, http.MethodGet, "/api/topics/progress", "", other.Result().Cookies()[0])
	if strings.Contains(isolated.Body.String(), first.ID) {
		t.Fatal("summary leaked another user's progress")
	}
	response = request(t, handler, http.MethodPost, "/api/topics/routine.drugs/reset", "", cookie)
	if response.Code != http.StatusConflict {
		t.Fatalf("unfinished topic must not lose progress: %s", response.Body.String())
	}
	if err := application.db.QueryRow(`SELECT count(*) FROM topic_answers`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("unfinished topic progress changed: %d %v", count, err)
	}
}

func TestRussianQuestionListTitlesAreConsistentWhenPresent(t *testing.T) {
	data, err := seed.Files.ReadFile("library.json")
	if err != nil {
		t.Fatal(err)
	}
	var library topicLibrary
	if err = json.Unmarshal(data, &library); err != nil {
		t.Fatal(err)
	}
	titles := map[string]string{}
	for _, q := range library.Questions {
		// New captures may retain their source prompt until a translation is requested.
		if strings.TrimSpace(q.QuestionRU) == "" {
			continue
		}
		if previous, ok := titles[q.CanonicalID]; ok && previous != q.QuestionRU {
			t.Fatalf("inconsistent shared translation: %s", q.CanonicalID)
		}
		titles[q.CanonicalID] = q.QuestionRU
	}
	if len(titles) == 0 {
		t.Fatal("existing Russian title metadata was lost")
	}
}
