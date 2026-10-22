package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestTopicRunHistoryAndIsolatedReviews(t *testing.T) {
	application, sender := newTestApp(t)
	handler := application.Handler()
	request(t, handler, "POST", "/api/auth/request-code", `{"email":"runs@example.com"}`, nil)
	login := request(t, handler, "POST", "/api/auth/verify-code", `{"email":"runs@example.com","code":"`+sender.code+`"}`, nil)
	cookie := login.Result().Cookies()[0]
	const path = "/api/topics/routine.drugs"
	var uid string
	if err := application.db.QueryRow(`SELECT id FROM users WHERE email='runs@example.com'`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	_, members, _, err := topicMembers("routine.drugs")
	if err != nil {
		t.Fatal(err)
	}
	// Simulate an answer from before history existed; migrate it exactly once.
	first, err := application.loadTopicQuestion(members[0])
	if err != nil {
		t.Fatal(err)
	}
	var wrongLetter, correctLetter string
	var wrongText string
	for _, choice := range first.Answers {
		if choice.Correct {
			correctLetter = choice.Letter
		} else {
			wrongLetter = choice.Letter
			wrongText = choice.Text
		}
	}
	if _, err = application.db.Exec(`INSERT INTO topic_answers VALUES(?,?,?,?,?,?)`, uid, "routine.drugs", first.ID, wrongText, false, "2026-10-01T10:00:00Z"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		res := request(t, handler, "GET", path, "", cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
	}
	history, err := application.topicHistory(uid, "routine.drugs")
	if err != nil || len(history) != 1 || history[0].Answered != 1 || history[0].StartedAt != "2026-10-01T10:00:00Z" {
		t.Fatalf("legacy migration: %+v %v", history, err)
	}
	parent := history[0].ID
	reviewPath := fmt.Sprintf("%s/reviews/%d", path, parent)
	if res := request(t, handler, "POST", reviewPath, "", cookie); res.Code != 409 {
		t.Fatal("accepted unfinished review")
	}
	for _, ref := range members[1:] {
		q, e := application.loadTopicQuestion(ref)
		if e != nil {
			t.Fatal(e)
		}
		letter := ""
		for _, a := range q.Answers {
			if a.Correct {
				letter = a.Letter
			}
		}
		res := request(t, handler, "POST", path+"/answers", fmt.Sprintf(`{"question_id":%q,"selected_letter":%q}`, q.ID, letter), cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
	}
	var reviewID struct {
		ID int64 `json:"id"`
	}
	for i := 0; i < 2; i++ {
		res := request(t, handler, "POST", reviewPath, "", cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
		var got struct {
			ID int64 `json:"id"`
		}
		json.Unmarshal(res.Body.Bytes(), &got)
		if i > 0 && got.ID != reviewID.ID {
			t.Fatal("duplicate review created")
		}
		reviewID = got
	}
	res := request(t, handler, "GET", fmt.Sprintf("%s?review=%d", path, reviewID.ID), "", cookie)
	var review struct {
		Questions []topicQuestion `json:"questions"`
	}
	json.Unmarshal(res.Body.Bytes(), &review)
	if res.Code != 200 || len(review.Questions) != 1 || review.Questions[0].ID != first.ID || review.Questions[0].Progress != nil {
		t.Fatalf("review membership: %s", res.Body.String())
	}
	invalid := request(t, handler, "POST", path+"/answers", fmt.Sprintf(`{"question_id":%q,"selected_letter":"A","review_id":%d}`, members[1].CanonicalID, reviewID.ID), cookie)
	if invalid.Code != 422 {
		t.Fatal("accepted a non-error question in review")
	}
	for _, letter := range []string{correctLetter, wrongLetter} {
		res = request(t, handler, "POST", path+"/answers", fmt.Sprintf(`{"question_id":%q,"selected_letter":%q,"review_id":%d}`, first.ID, letter, reviewID.ID), cookie)
		if res.Code != 200 {
			t.Fatal(res.Body.String())
		}
	}
	history, err = application.topicHistory(uid, "routine.drugs")
	if err != nil || len(history) != 1 || history[0].Correct != len(members)-1 || history[0].Wrong != 1 || history[0].CompletedAt == nil || history[0].Review == nil || history[0].Review.Correct != 1 || history[0].Review.CompletedAt == nil {
		t.Fatalf("history changed or review incomplete: %+v %v", history, err)
	}
	res = request(t, handler, "GET", "/api/topics/progress", "", cookie)
	var summaries map[string]struct {
		Correct int               `json:"correct"`
		Wrong   int               `json:"wrong"`
		Runs    []topicRunSummary `json:"runs"`
	}
	json.Unmarshal(res.Body.Bytes(), &summaries)
	if summaries["routine.drugs"].Wrong != 1 || summaries["routine.drugs"].Correct != len(members)-1 || len(summaries["routine.drugs"].Runs) != 1 {
		t.Fatal("review overwrote main statistics")
	}
	// Repeat the full topic while keeping the prior run and its review available.
	res = request(t, handler, "POST", path+"/reset", "", cookie)
	if res.Code != 204 {
		t.Fatal(res.Body.String())
	}
	history, err = application.topicHistory(uid, "routine.drugs")
	if err != nil || len(history) != 2 || history[0].Answered != 0 || history[1].Wrong != 1 || history[1].Review == nil {
		t.Fatalf("repeat lost history: %+v %v", history, err)
	}
	res = request(t, handler, "GET", fmt.Sprintf("%s?review=%d", path, reviewID.ID), "", cookie)
	json.Unmarshal(res.Body.Bytes(), &review)
	if len(review.Questions) != 1 || review.Questions[0].Progress == nil || !review.Questions[0].Progress.Correct {
		t.Fatal("old review not restored after full repeat")
	}
	request(t, handler, "POST", "/api/auth/request-code", `{"email":"isolated-runs@example.com"}`, nil)
	other := request(t, handler, "POST", "/api/auth/verify-code", `{"email":"isolated-runs@example.com","code":"`+sender.code+`"}`, nil).Result().Cookies()[0]
	if res = request(t, handler, "POST", reviewPath, "", other); res.Code != http.StatusNotFound {
		t.Fatal("review leaked across users")
	}
	if res = request(t, handler, "GET", fmt.Sprintf("%s?review=%d", path, reviewID.ID), "", other); res.Code != http.StatusNotFound {
		t.Fatal("review answers leaked across users")
	}
}
