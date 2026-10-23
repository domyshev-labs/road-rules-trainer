package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/domyshev-labs/road-rules-trainer/backend/seed"
)

type linearAnswer struct {
	Letter   string `json:"letter"`
	Text     string `json:"text"`
	Correct  bool   `json:"correct"`
	Selected bool   `json:"selected"`
}
type linearEvent struct {
	ID        string            `json:"id"`
	ContentID string            `json:"content_id"`
	Topic     string            `json:"topic"`
	At        string            `json:"answered_at"`
	Correct   bool              `json:"correct"`
	Mode      string            `json:"mode"`
	Question  string            `json:"question"`
	Image     string            `json:"image_url"`
	Answers   []linearAnswer    `json:"answers"`
	Help      map[string]string `json:"help"`
	selected  string
	topicID   string
	testID    int
}

// Real answer records are used here; inherited progress is never an event.
func (app *App) linearStatistics(w http.ResponseWriter, r *http.Request) {
	limit := 30
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || (n != 30 && n != 50 && n != 100 && n != 250 && n != 500 && n != 1000) {
			app.writeError(w, 422, "Некорректный размер ряда")
			return
		}
		limit = n
	}
	uid := r.Context().Value(userContextKey).(user).ID
	rows, err := app.db.Query(`WITH events AS (
 SELECT 'topic:'||r.id||':'||a.content_id id,r.user_id,a.content_id,a.selected_text,a.correct,a.answered_at,r.topic_id,0 test_id,CASE WHEN r.parent_id IS NULL THEN 'training' ELSE 'mistakes' END mode
 FROM topic_run_answers a JOIN topic_runs r ON r.id=a.run_id
 UNION ALL
 SELECT 'ticket:'||t.id||':'||a.question_id,t.user_id,m.content_id,COALESCE(c.text,''),a.correct,a.answered_at,'',t.test_id,t.mode
 FROM attempt_answers a JOIN attempts t ON t.id=a.attempt_id JOIN question_memberships m ON m.question_id=a.question_id LEFT JOIN answers c ON c.question_id=a.question_id AND c.letter=a.selected_letter
 UNION ALL
 SELECT 'legacy:'||a.topic_id||':'||a.content_id,a.user_id,a.content_id,a.selected_text,a.correct,a.answered_at,a.topic_id,0,'training' FROM topic_answers a
 WHERE NOT EXISTS(SELECT 1 FROM topic_run_answers b JOIN topic_runs r ON r.id=b.run_id WHERE r.user_id=a.user_id AND r.topic_id=a.topic_id AND b.content_id=a.content_id AND b.answered_at=a.answered_at AND b.selected_text=a.selected_text)
 ) SELECT id,content_id,selected_text,correct,answered_at,topic_id,test_id,mode FROM events WHERE user_id=? ORDER BY julianday(answered_at) DESC,answered_at DESC,id DESC LIMIT ?`, uid, limit)
	if err != nil {
		app.writeError(w, 500, "Не удалось загрузить историю")
		return
	}
	events := []linearEvent{}
	for rows.Next() {
		var e linearEvent
		if err = rows.Scan(&e.ID, &e.ContentID, &e.selected, &e.Correct, &e.At, &e.topicID, &e.testID, &e.Mode); err != nil {
			rows.Close()
			app.writeError(w, 500, "Не удалось прочитать историю")
			return
		}
		events = append(events, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		app.writeError(w, 500, "Не удалось прочитать историю")
		return
	}
	data, err := seed.Files.ReadFile("library.json")
	if err != nil {
		app.writeError(w, 500, "Библиотека недоступна")
		return
	}
	var library topicLibrary
	if json.Unmarshal(data, &library) != nil {
		app.writeError(w, 500, "Библиотека недоступна")
		return
	}
	refs := map[string]topicReference{}
	labels := map[string]string{}
	for _, n := range library.Nodes {
		labels[n.ID] = n.Label
	}
	for _, q := range library.Questions {
		if q.Verified {
			if _, ok := refs[q.CanonicalID]; !ok {
				refs[q.CanonicalID] = q
			}
		}
	}
	cache := map[string]topicQuestion{}
	for i := range events {
		e := &events[i]
		ref, ok := refs[e.ContentID]
		if !ok {
			app.writeError(w, 500, "Вопрос истории недоступен")
			return
		}
		q, cached := cache[e.ContentID]
		if !cached {
			q, err = app.loadTopicQuestion(ref)
			if err != nil {
				app.writeError(w, 500, "Вопрос истории недоступен")
				return
			}
			cache[e.ContentID] = q
		}
		e.Question = q.Question
		e.Image = q.Image
		e.Help = q.Help
		e.Answers = []linearAnswer{}
		for _, a := range q.Answers {
			e.Answers = append(e.Answers, linearAnswer{a.Letter, a.Text, a.Correct, e.selected != "" && normalizeTopicText(a.Text) == normalizeTopicText(e.selected)})
		}
		e.Topic = labels[e.topicID]
		if e.Topic == "" && e.testID != 0 {
			kind := "Тематический билет"
			id := e.testID
			if id >= 100000 {
				kind = "Экзамен"
				id -= 100000
			}
			e.Topic = fmt.Sprintf("%s %d", kind, id)
		}
		if e.Topic == "" {
			e.Topic = "Тема из предыдущей структуры"
		}
	}
	// The selected tail is displayed from oldest to newest.
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	app.writeJSON(w, 200, events)
}

func (app *App) releases(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(filepath.Join(filepath.Dir(app.cfg.DatabasePath), "releases.json"))
	if err != nil {
		data, err = seed.Files.ReadFile("releases.json")
	}
	if err != nil || !json.Valid(data) {
		app.writeError(w, 500, "История версий недоступна")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}
