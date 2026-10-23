package app

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestLinearStatisticsRealEventsAndIsolation(t *testing.T) {
	app, sender := newTestApp(t)
	uid, cookie := signInProgressUser(t, app, sender, "timeline@example.com")
	_, other := signInProgressUser(t, app, sender, "other-timeline@example.com")
	_, members, _, err := topicMembers("routine.drugs")
	if err != nil {
		t.Fatal(err)
	}
	ref := members[0]
	q, err := app.loadTopicQuestion(ref)
	if err != nil {
		t.Fatal(err)
	}
	selected := ""
	for _, a := range q.Answers {
		if a.Correct {
			selected = a.Text
		}
	}
	putLegacyKnowledge(t, app, uid, "routine.drugs", ref, true, "2026-10-01T10:00:00Z")
	for i := 0; i < 3; i++ {
		result, err := app.db.Exec(`INSERT INTO topic_runs(user_id,topic_id,total,started_at) VALUES(?,'routine.drugs',1,?)`, uid, fmt.Sprintf("2026-10-01T1%d:00:00Z", i))
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		answerText := selected
		if i == 1 {
			for _, a := range q.Answers {
				if !a.Correct {
					answerText = a.Text
					break
				}
			}
		}
		if i == 2 {
			_, err = app.db.Exec(`INSERT INTO topic_run_inherited VALUES(?,?,?,?,?)`, id, q.ID, selected, true, "2026-10-01T12:00:00Z")
		} else {
			_, err = app.db.Exec(`INSERT INTO topic_run_answers VALUES(?,?,?,?,?)`, id, q.ID, answerText, i == 0, fmt.Sprintf("2026-10-01T1%d:00:00Z", i))
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	response := request(t, app.Handler(), "GET", "/api/statistics/linear?limit=30", "", cookie)
	var events []linearEvent
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &events) != nil {
		t.Fatal(response.Body.String())
	}
	if len(events) != 2 || !events[0].Correct || events[1].Correct || events[0].At >= events[1].At {
		t.Fatal(response.Body.String())
	}
	if len(events[0].Answers) == 0 || events[0].Question == "" || events[0].Topic != "Наркотики" {
		t.Fatal(response.Body.String())
	}
	selectedCount, correctCount := 0, 0
	for _, a := range events[0].Answers {
		if a.Selected {
			selectedCount++
		}
		if a.Correct {
			correctCount++
		}
	}
	if selectedCount != 1 || correctCount != 1 {
		t.Fatal(response.Body.String())
	}
	response = request(t, app.Handler(), "GET", "/api/statistics/linear", "", other)
	if response.Code != 200 || response.Body.String() != "[]\n" {
		t.Fatal(response.Body.String())
	}
	if request(t, app.Handler(), "GET", "/api/statistics/linear?limit=9999", "", cookie).Code != 422 {
		t.Fatal("limit must be validated")
	}
	if request(t, app.Handler(), "GET", "/api/statistics/linear", "", nil).Code != 401 {
		t.Fatal("history requires authentication")
	}
}

func TestStatisticsPaginationAndTopicFilters(t *testing.T) {
	app, sender := newTestApp(t)
	uid, cookie := signInProgressUser(t, app, sender, "paged-statistics@example.com")
	_, other := signInProgressUser(t, app, sender, "isolated-statistics@example.com")
	_, members, _, err := topicMembers("routine.drugs")
	if err != nil {
		t.Fatal(err)
	}
	ref := members[0]
	q, err := app.loadTopicQuestion(ref)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 60; i++ {
		topic := "routine.drugs"
		correct := i%3 == 0
		if i >= 35 {
			topic = "routine.alcohol"
			correct = true
		}
		selected := ""
		for _, a := range q.Answers {
			if a.Correct == correct {
				selected = a.Text
				break
			}
		}
		at := fmt.Sprintf("2026-10-%02dT12:%02d:00Z", 1+i/30, i%30)
		result, err := app.db.Exec(`INSERT INTO topic_runs(user_id,topic_id,total,started_at) VALUES(?,?,1,?)`, uid, topic, at)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		if _, err = app.db.Exec(`INSERT INTO topic_run_answers VALUES(?,?,?,?,?)`, id, ref.CanonicalID, selected, correct, at); err != nil {
			t.Fatal(err)
		}
	}
	var page struct {
		Events  []linearEvent `json:"events"`
		Total   int           `json:"total"`
		Correct int           `json:"correct"`
		More    bool          `json:"has_more"`
	}
	get := func(url string, out any) {
		t.Helper()
		r := request(t, app.Handler(), "GET", url, "", cookie)
		if r.Code != 200 || json.Unmarshal(r.Body.Bytes(), out) != nil {
			t.Fatalf("%s: %d %s", url, r.Code, r.Body.String())
		}
	}
	get("/api/statistics/linear?paged=1", &page)
	if len(page.Events) != 50 || page.Total != 60 || page.Correct != 37 || !page.More || page.Events[0].At < page.Events[49].At {
		t.Fatalf("unexpected first page: %+v", page)
	}
	ids := map[string]bool{}
	for _, e := range page.Events {
		ids[e.ID] = true
	}
	get("/api/statistics/linear?paged=1&offset=50", &page)
	if len(page.Events) != 10 || page.More || page.Total != 60 {
		t.Fatalf("unexpected last page: %+v", page)
	}
	for _, e := range page.Events {
		if ids[e.ID] {
			t.Fatal("overlapping pages")
		}
	}
	var topics struct {
		Rows  []statisticsTopicRow `json:"rows"`
		Total int                  `json:"total"`
		More  bool                 `json:"has_more"`
		Days  []string             `json:"days"`
	}
	get("/api/statistics/topics?filter=all", &topics)
	if topics.Total != 2 || len(topics.Rows) != 2 || topics.Rows[0].Topic != "Наркотики" || topics.Rows[0].Wrong != 23 || len(topics.Days) != 2 {
		t.Fatalf("unexpected topics: %+v", topics)
	}
	get("/api/statistics/topics?filter=all&sort=correct&direction=desc", &topics)
	if topics.Rows[0].Topic != "Алкоголь" || topics.Rows[0].Correct != 25 {
		t.Fatalf("correct sort: %+v", topics)
	}
	get("/api/statistics/topics?filter=errors", &topics)
	if topics.Total != 1 || topics.Rows[0].Wrong != 23 {
		t.Fatalf("error filter: %+v", topics)
	}
	get("/api/statistics/topics?filter=perfect", &topics)
	if topics.Total != 1 || topics.Rows[0].Topic != "Алкоголь" {
		t.Fatalf("perfect filter: %+v", topics)
	}
	get("/api/statistics/topics?filter=all&from=2026-10-01&to=2026-10-01", &topics)
	if topics.Total != 1 || topics.Rows[0].Correct != 10 || topics.Rows[0].Wrong != 20 {
		t.Fatalf("calendar range: %+v", topics)
	}
	get("/api/statistics/topics?filter=all&offset=1", &topics)
	if len(topics.Rows) != 1 || topics.More {
		t.Fatalf("topic pagination: %+v", topics)
	}
	for _, url := range []string{"/api/statistics/linear?paged=1&offset=-1", "/api/statistics/topics?from=no", "/api/statistics/topics?sort=no", "/api/statistics/topics?filter=no"} {
		if request(t, app.Handler(), "GET", url, "", cookie).Code != 422 {
			t.Fatalf("invalid query accepted: %s", url)
		}
	}
	response := request(t, app.Handler(), "GET", "/api/statistics/topics?filter=all", "", other)
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &topics) != nil || topics.Total != 0 || len(topics.Days) != 0 {
		t.Fatal(response.Body.String())
	}
	if request(t, app.Handler(), "GET", "/api/statistics/topics", "", nil).Code != 401 {
		t.Fatal("topics require authentication")
	}
}
