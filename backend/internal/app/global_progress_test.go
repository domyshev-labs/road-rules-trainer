package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func signInProgressUser(t *testing.T, app *App, sender *capturedEmail, email string) (string, *http.Cookie) {
	t.Helper()
	h := app.Handler()
	request(t, h, "POST", "/api/auth/request-code", fmt.Sprintf(`{"email":%q}`, email), nil)
	res := request(t, h, "POST", "/api/auth/verify-code", fmt.Sprintf(`{"email":%q,"code":%q}`, email, sender.code), nil)
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	var id string
	if err := app.db.QueryRow(`SELECT id FROM users WHERE email=?`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id, res.Result().Cookies()[0]
}
func putLegacyKnowledge(t *testing.T, app *App, user, topic string, ref topicReference, correct bool, at string) {
	t.Helper()
	q, err := app.loadTopicQuestion(ref)
	if err != nil {
		t.Fatal(err)
	}
	text := ""
	for _, a := range q.Answers {
		if a.Correct == correct {
			text = a.Text
			break
		}
	}
	if _, err = app.db.Exec(`INSERT INTO topic_answers VALUES(?,?,?,?,?,?)`, user, topic, q.ID, text, correct, at); err != nil {
		t.Fatal(err)
	}
}

func TestGlobalKnowledgeFollowsMovedAndSharedQuestions(t *testing.T) {
	app, sender := newTestApp(t)
	uid, cookie := signInProgressUser(t, app, sender, "global@example.com")
	_, members, _, err := topicMembers("routine.drugs")
	if err != nil {
		t.Fatal(err)
	}
	ref := members[0]
	// The original topic no longer has to exist or contain this question.
	putLegacyKnowledge(t, app, uid, "old-topic-before-reorganization", ref, false, "2026-10-01T10:00:00Z")
	response := request(t, app.Handler(), "GET", "/api/topics/progress", "", cookie)
	var summaries map[string]struct {
		Answered int             `json:"answered"`
		Wrong    int             `json:"wrong"`
		Results  map[string]bool `json:"results"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &summaries); err != nil {
		t.Fatal(err)
	}
	if summaries["routine.drugs"].Answered != 1 || summaries["routine.drugs"].Wrong != 1 {
		t.Fatal(response.Body.String())
	}
	res := request(t, app.Handler(), "GET", "/api/topics/routine.drugs", "", cookie)
	var topic struct {
		RunID     int64           `json:"run_id"`
		Questions []topicQuestion `json:"questions"`
	}
	if err = json.Unmarshal(res.Body.Bytes(), &topic); err != nil {
		t.Fatal(err)
	}
	if res.Code != 200 || topic.Questions[0].Progress == nil || topic.Questions[0].Progress.Correct {
		t.Fatal(res.Body.String())
	}
	var events, inherited int
	app.db.QueryRow(`SELECT COUNT(*) FROM topic_run_answers WHERE run_id=?`, topic.RunID).Scan(&events)
	app.db.QueryRow(`SELECT COUNT(*) FROM topic_run_inherited WHERE run_id=?`, topic.RunID).Scan(&inherited)
	if events != 0 || inherited != 1 {
		t.Fatalf("inherited knowledge fabricated answer events: %d %d", events, inherited)
	}
	// Knowledge acquired elsewhere after opening the topic is inherited on return.
	putLegacyKnowledge(t, app, uid, "other-topic-later", members[1], true, "2026-10-02T10:00:00Z")
	res = request(t, app.Handler(), "GET", fmt.Sprintf("/api/topics/routine.drugs?run=%d", topic.RunID), "", cookie)
	if err = json.Unmarshal(res.Body.Bytes(), &topic); err != nil {
		t.Fatal(err)
	}
	if res.Code != 200 || topic.Questions[1].Progress == nil || !topic.Questions[1].Progress.Correct {
		t.Fatal("explicit current-run navigation lost shared progress", res.Body.String())
	}
	_, other := signInProgressUser(t, app, sender, "other@example.com")
	res = request(t, app.Handler(), "GET", "/api/questions/progress", "", other)
	if res.Body.String() != "{}\n" {
		t.Fatal("another user's knowledge leaked", res.Body.String())
	}
}

func TestReorganizationMarksOnlyUnansweredAdditionsNew(t *testing.T) {
	app, sender := newTestApp(t)
	uid, _ := signInProgressUser(t, app, sender, "added@example.com")
	app.db.Exec(`UPDATE users SET created_at='2020-01-01T00:00:00Z' WHERE id=?`, uid)
	_, members, _, _ := topicMembers("routine.drugs")
	app.db.Exec(`UPDATE taxonomy_memberships SET initial_member=1 WHERE topic_id='routine.drugs'`)
	// Existing canonical content newly assigned to a topic is still new if unanswered.
	for _, ref := range members[:2] {
		app.db.Exec(`INSERT INTO taxonomy_memberships VALUES(?,?,1,'2026-10-01T00:00:00Z',0) ON CONFLICT(topic_id,content_id) DO UPDATE SET added_at=excluded.added_at,initial_member=0`, "routine.drugs", ref.CanonicalID)
	}
	putLegacyKnowledge(t, app, uid, "another-topic", members[0], true, "2026-10-02T00:00:00Z")
	pending, _, err := app.newTopicQuestions(uid, "routine.drugs", members)
	if err != nil || len(pending) != 1 || pending[0] != members[1].CanonicalID {
		t.Fatalf("unexpected new additions: %v %v", pending, err)
	}
	// Restarting with unchanged taxonomy cannot erase a pending New marker.
	if err = reconcileTopicMemberships(app.db); err != nil {
		t.Fatal(err)
	}
	again, _, err := app.newTopicQuestions(uid, "routine.drugs", members)
	if err != nil || len(again) != 1 || again[0] != pending[0] {
		t.Fatalf("pending addition lost across restart: %v %v", again, err)
	}
}

func TestTicketAnswersTransferIntoTopicKnowledge(t *testing.T) {
	app, sender := newTestApp(t)
	uid, cookie := signInProgressUser(t, app, sender, "ticket-global@example.com")
	_, members, _, _ := topicMembers("routine.drugs")
	ref := members[0]
	var questionID int
	var letter string
	err := app.db.QueryRow(`SELECT q.id,a.letter FROM questions q JOIN answers a ON a.question_id=q.id AND a.correct=1 WHERE q.test_id=? AND q.ordinal=?`, ref.TestID, ref.Index+1).Scan(&questionID, &letter)
	if err != nil {
		t.Fatal(err)
	}
	app.db.Exec(`INSERT INTO attempts VALUES('ticket-global',NULL,?,?,'full',1,'2026-10-01T00:00:00Z',NULL)`, uid, ref.TestID)
	app.db.Exec(`INSERT INTO attempt_answers VALUES('ticket-global',?,?,1,'2026-10-01T00:01:00Z')`, questionID, letter)
	known, err := app.globalAnswers(uid)
	if err != nil || !known[ref.CanonicalID].Correct {
		t.Fatalf("ticket answer not shared: %v %v", known, err)
	}
	res := request(t, app.Handler(), "GET", "/api/questions/progress", "", cookie)
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	var feedback map[string]struct {
		Correct     bool   `json:"correct"`
		CorrectText string `json:"correct_text"`
	}
	json.Unmarshal(res.Body.Bytes(), &feedback)
	if !feedback[ref.CanonicalID].Correct || feedback[ref.CanonicalID].CorrectText == "" {
		t.Fatal(res.Body.String())
	}
}

func TestHistoricalRunSurvivesRemovedMembership(t *testing.T) {
	app, sender := newTestApp(t)
	uid, _ := signInProgressUser(t, app, sender, "frozen-global@example.com")
	_, members, _, _ := topicMembers("routine.drugs")
	old := members[:2]
	tx, _ := app.db.Begin()
	id, err := ensureTopicRun(tx, uid, "routine.drugs", old)
	if err != nil {
		t.Fatal(err)
	}
	tx.Commit()
	tx, _ = app.db.Begin()
	next, err := ensureTopicRun(tx, uid, "routine.drugs", members[1:])
	if err != nil {
		t.Fatal(err)
	}
	tx.Commit()
	if next == id {
		t.Fatal("current run still contains removed question")
	}
	historical, _, err := app.runMembers(uid, "routine.drugs", id, members[1:])
	if err != nil || len(historical) != 2 || historical[0].CanonicalID != old[0].CanonicalID {
		t.Fatalf("historical membership lost: %v %v", historical, err)
	}
}
