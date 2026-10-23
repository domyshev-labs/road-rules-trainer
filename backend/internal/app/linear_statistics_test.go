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
