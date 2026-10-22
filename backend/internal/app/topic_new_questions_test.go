package app

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestAddedQuestionsGetSeparateRunsAndReopenTopic(t *testing.T) {
	app, sender := newTestApp(t)
	handler := app.Handler()
	request(t, handler, "POST", "/api/auth/request-code", `{"email":"new-questions@example.com"}`, nil)
	login := request(t, handler, "POST", "/api/auth/verify-code", `{"email":"new-questions@example.com","code":"`+sender.code+`"}`, nil)
	cookie := login.Result().Cookies()[0]
	var uid string
	if err := app.db.QueryRow(`SELECT id FROM users WHERE email='new-questions@example.com'`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	const topicID = "routine.drugs"
	const path = "/api/topics/" + topicID
	_, members, _, err := topicMembers(topicID)
	if err != nil {
		t.Fatal(err)
	}
	baseline := members[:len(members)-2]
	added := members[len(members)-2:]
	// This completed snapshot predates the final two library memberships.
	tx, err := app.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	result, err := tx.Exec(`INSERT INTO topic_runs(user_id,topic_id,total,started_at,completed_at) VALUES(?,?,?,?,?)`, uid, topicID, len(baseline), "2026-10-01T10:00:00Z", "2026-10-01T11:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	oldID, _ := result.LastInsertId()
	// Leave membership absent to exercise migration of a completed legacy run.
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, ref := range baseline {
		q, e := app.loadTopicQuestion(ref)
		if e != nil {
			t.Fatal(e)
		}
		text := ""
		for _, a := range q.Answers {
			if a.Correct {
				text = a.Text
			}
		}
		if _, err = app.db.Exec(`INSERT INTO topic_answers VALUES(?,?,?,?,?,?)`, uid, topicID, q.ID, text, true, "2026-10-01T10:30:00Z"); err != nil {
			t.Fatal(err)
		}
		if _, err = app.db.Exec(`INSERT INTO topic_run_answers VALUES(?,?,?,?,?)`, oldID, q.ID, text, true, "2026-10-01T10:30:00Z"); err != nil {
			t.Fatal(err)
		}
	}
	type state struct {
		NewCount  int               `json:"new_count"`
		NewIDs    []string          `json:"new_question_ids"`
		Completed bool              `json:"completed"`
		Answered  int               `json:"answered"`
		Runs      []topicRunSummary `json:"runs"`
	}
	summary := func() state {
		t.Helper()
		res := request(t, handler, "GET", "/api/topics/progress", "", cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
		var all map[string]state
		if err = json.Unmarshal(res.Body.Bytes(), &all); err != nil {
			t.Fatal(err)
		}
		return all[topicID]
	}
	stats := summary()
	if stats.NewCount != 2 || stats.Completed || stats.Answered != len(baseline) || len(stats.Runs) != 1 || stats.Runs[0].Total != len(baseline) {
		t.Fatalf("topic was not reopened: %+v", stats)
	}
	// A newly tagged duplicate source of existing canonical content is already in the baseline.
	duplicate := append(append([]topicReference{}, members...), baseline[0])
	pending, _, err := app.newTopicQuestions(uid, topicID, duplicate)
	if err != nil || len(pending) != 2 {
		t.Fatalf("duplicate treated as new: %v %v", pending, err)
	}
	invalid := request(t, handler, "POST", path+"/answers", fmt.Sprintf(`{"question_id":%q,"selected_letter":"A","run_id":%d}`, added[0].CanonicalID, oldID), cookie)
	if invalid.Code != 422 {
		t.Fatal("new answer could mutate completed full run")
	}
	var run struct {
		ID int64 `json:"id"`
	}
	for i := 0; i < 2; i++ {
		res := request(t, handler, "POST", path+"/new", "", cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
		var got struct {
			ID int64 `json:"id"`
		}
		json.Unmarshal(res.Body.Bytes(), &got)
		if i > 0 && got.ID != run.ID {
			t.Fatal("duplicate new batch")
		}
		run = got
	}
	load := func() []topicQuestion {
		t.Helper()
		res := request(t, handler, "GET", fmt.Sprintf("%s?run=%d", path, run.ID), "", cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
		var data struct {
			Questions []topicQuestion `json:"questions"`
			Kind      string          `json:"kind"`
		}
		json.Unmarshal(res.Body.Bytes(), &data)
		if data.Kind != "new" || len(data.Questions) != 2 {
			t.Fatal(res.Body.String())
		}
		return data.Questions
	}
	questions := load()
	if questions[0].Number != 1 || questions[1].Number != 2 {
		t.Fatal("incorrect new-batch numbering")
	}
	for i, ref := range added {
		q, e := app.loadTopicQuestion(ref)
		if e != nil {
			t.Fatal(e)
		}
		letter := ""
		for _, a := range q.Answers {
			if a.Correct == (i == 0) {
				letter = a.Letter
			}
		}
		res := request(t, handler, "POST", path+"/answers", fmt.Sprintf(`{"question_id":%q,"selected_letter":%q,"run_id":%d}`, q.ID, letter, run.ID), cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
		stats = summary()
		if stats.NewCount != 1-i || stats.Completed != (i == 1) {
			t.Fatalf("incorrect pending state: %+v", stats)
		}
		if stats.Runs[1].ID != oldID || stats.Runs[1].Total != len(baseline) || stats.Runs[1].Correct != len(baseline) {
			t.Fatal("original history changed")
		}
		if i == 0 {
			if load()[0].Progress == nil {
				t.Fatal("partial batch did not resume")
			}
			if stats.Runs[0].CompletedAt != nil {
				t.Fatal("batch completed early")
			}
		}
	}
	stats = summary()
	if stats.Runs[0].Kind != "new" || stats.Runs[0].Total != 2 || stats.Runs[0].Correct != 1 || stats.Runs[0].Wrong != 1 || stats.Runs[0].CompletedAt == nil {
		t.Fatalf("incorrect new history record: %+v", stats.Runs)
	}
	res := request(t, handler, "POST", path+"/new", "", cookie)
	if res.Code != 409 {
		t.Fatal("created an empty new batch")
	}
	// A new-question batch supports its own mistake review, without changing full/new results.
	res = request(t, handler, "POST", fmt.Sprintf("%s/reviews/%d", path, run.ID), "", cookie)
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	// Historical full membership stays frozen when navigating to it again.
	res = request(t, handler, "GET", path, "", cookie)
	var full struct {
		Questions []topicQuestion `json:"questions"`
	}
	json.Unmarshal(res.Body.Bytes(), &full)
	if len(full.Questions) != len(baseline) {
		t.Fatal("full run grew after new questions")
	}
	// A full repeat takes a fresh snapshot and must not mark all old questions as new.
	res = request(t, handler, "POST", path+"/reset", "", cookie)
	if res.Code != 204 {
		t.Fatal(res.Body.String())
	}
	stats = summary()
	if stats.NewCount != 0 || !stats.Completed || stats.Answered != len(members) || stats.Runs[0].Answered != 0 || stats.Runs[0].CompletedAt != nil {
		t.Fatalf("repeat baseline incorrect: %+v", stats)
	}
}

func TestNewBatchStaysFrozenWhileMoreQuestionsAppear(t *testing.T) {
	app, sender := newTestApp(t)
	handler := app.Handler()
	request(t, handler, "POST", "/api/auth/request-code", `{"email":"new-batches@example.com"}`, nil)
	login := request(t, handler, "POST", "/api/auth/verify-code", `{"email":"new-batches@example.com","code":"`+sender.code+`"}`, nil)
	cookie := login.Result().Cookies()[0]
	var uid string
	if err := app.db.QueryRow(`SELECT id FROM users WHERE email='new-batches@example.com'`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	const topicID = "routine.drugs"
	const path = "/api/topics/" + topicID
	_, members, _, err := topicMembers(topicID)
	if err != nil {
		t.Fatal(err)
	}
	baseline, added := members[:len(members)-3], members[len(members)-3:]
	if _, err = app.currentTopicRun(uid, topicID, baseline); err != nil {
		t.Fatal(err)
	}
	// Two additions were already being answered when a third arrived.
	tx, err := app.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	result, err := tx.Exec(`INSERT INTO topic_runs(user_id,topic_id,kind,total,started_at) VALUES(?,?,'new',2,'2026-10-01T10:00:00Z')`, uid, topicID)
	if err != nil {
		t.Fatal(err)
	}
	batch, _ := result.LastInsertId()
	if err = saveRunMembers(tx, batch, added[:2]); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	res := request(t, handler, "POST", path+"/new", "", cookie)
	var resumed struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(res.Body.Bytes(), &resumed)
	if res.Code != 200 || resumed.ID != batch {
		t.Fatalf("did not resume frozen batch: %s", res.Body.String())
	}
	res = request(t, handler, "GET", fmt.Sprintf("%s?run=%d", path, batch), "", cookie)
	var data struct {
		Questions []topicQuestion `json:"questions"`
	}
	json.Unmarshal(res.Body.Bytes(), &data)
	if len(data.Questions) != 2 {
		t.Fatal("active batch expanded")
	}
	for _, ref := range added[:2] {
		res = request(t, handler, "POST", path+"/answers", fmt.Sprintf(`{"question_id":%q,"selected_letter":"A","run_id":%d}`, ref.CanonicalID, batch), cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
	}
	res = request(t, handler, "POST", path+"/new", "", cookie)
	var next struct {
		ID int64 `json:"id"`
	}
	json.Unmarshal(res.Body.Bytes(), &next)
	if res.Code != 200 || next.ID == batch {
		t.Fatalf("missing subsequent batch: %s", res.Body.String())
	}
	res = request(t, handler, "GET", fmt.Sprintf("%s?run=%d", path, next.ID), "", cookie)
	json.Unmarshal(res.Body.Bytes(), &data)
	if len(data.Questions) != 1 || data.Questions[0].ID != added[2].CanonicalID {
		t.Fatalf("wrong follow-up batch: %s", res.Body.String())
	}
	history, err := app.topicHistory(uid, topicID)
	if err != nil || len(history) != 3 || history[1].Total != 2 || history[1].CompletedAt == nil || history[2].Kind != "full" || history[2].Answered != 0 {
		t.Fatalf("history contaminated: %+v %v", history, err)
	}
}
