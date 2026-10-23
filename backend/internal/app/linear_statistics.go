package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"

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

const statisticsEvents = `WITH events AS (
 SELECT 'topic:'||r.id||':'||a.content_id id,r.user_id,a.content_id,a.selected_text,a.correct,a.answered_at,r.topic_id,0 test_id,CASE WHEN r.parent_id IS NULL THEN 'training' ELSE 'mistakes' END mode
 FROM topic_run_answers a JOIN topic_runs r ON r.id=a.run_id
 UNION ALL
 SELECT 'ticket:'||t.id||':'||a.question_id,t.user_id,m.content_id,COALESCE(c.text,''),a.correct,a.answered_at,'',t.test_id,t.mode
 FROM attempt_answers a JOIN attempts t ON t.id=a.attempt_id JOIN question_memberships m ON m.question_id=a.question_id LEFT JOIN answers c ON c.question_id=a.question_id AND c.letter=a.selected_letter
 UNION ALL
 SELECT 'legacy:'||a.topic_id||':'||a.content_id,a.user_id,a.content_id,a.selected_text,a.correct,a.answered_at,a.topic_id,0,'training' FROM topic_answers a
 WHERE NOT EXISTS(SELECT 1 FROM topic_run_answers b JOIN topic_runs r ON r.id=b.run_id WHERE r.user_id=a.user_id AND r.topic_id=a.topic_id AND b.content_id=a.content_id AND b.answered_at=a.answered_at AND b.selected_text=a.selected_text)
 )`

// Real answer records are used here; inherited progress is never an event.
func (app *App) linearStatistics(w http.ResponseWriter, r *http.Request) {
	paged := r.URL.Query().Get("paged") == "1"
	limit := 30
	if paged {
		limit = 50
	}
	offset, valid := statisticsOffset(r)
	if !valid {
		app.writeError(w, 422, "Некорректная страница")
		return
	}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || (n != 30 && n != 50 && n != 100 && n != 250 && n != 500 && n != 1000) {
			app.writeError(w, 422, "Некорректный размер ряда")
			return
		}
		limit = n
	}
	uid := r.Context().Value(userContextKey).(user).ID
	rows, err := app.db.Query(statisticsEvents+` SELECT id,content_id,selected_text,correct,answered_at,topic_id,test_id,mode FROM events WHERE user_id=? ORDER BY julianday(answered_at) DESC,answered_at DESC,id DESC LIMIT ? OFFSET ?`, uid, limit, offset)
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
		e.Topic = statisticsTopicLabel(labels, e.topicID, e.testID)
	}
	if paged {
		var total, correct int
		if err := app.db.QueryRow(statisticsEvents+` SELECT count(*),COALESCE(sum(correct),0) FROM events WHERE user_id=?`, uid).Scan(&total, &correct); err != nil {
			app.writeError(w, 500, "Не удалось загрузить итоги")
			return
		}
		app.writeJSON(w, 200, map[string]any{"events": events, "total": total, "correct": correct, "has_more": offset+len(events) < total})
		return
	}
	// Keep the previous response format for older clients.
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	app.writeJSON(w, 200, events)
}

func statisticsOffset(r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("offset")
	if raw == "" {
		return 0, true
	}
	n, err := strconv.Atoi(raw)
	return n, err == nil && n >= 0 && n <= 10000000
}

type statisticsTopicRow struct {
	Topic   string `json:"topic"`
	Correct int    `json:"correct"`
	Wrong   int    `json:"wrong"`
}

func (app *App) topicStatistics(w http.ResponseWriter, r *http.Request) {
	offset, valid := statisticsOffset(r)
	if !valid {
		app.writeError(w, 422, "Некорректная страница")
		return
	}
	filter := r.URL.Query().Get("filter")
	if filter != "" && filter != "all" && filter != "errors" && filter != "perfect" {
		app.writeError(w, 422, "Некорректный фильтр")
		return
	}
	sortBy := r.URL.Query().Get("sort")
	if sortBy == "" {
		sortBy = "wrong"
	}
	if sortBy != "wrong" && sortBy != "correct" {
		app.writeError(w, 422, "Некорректная сортировка")
		return
	}
	direction := r.URL.Query().Get("direction")
	if direction != "" && direction != "asc" && direction != "desc" {
		app.writeError(w, 422, "Некорректная сортировка")
		return
	}
	uid := r.Context().Value(userContextKey).(user).ID
	where := " WHERE user_id=?"
	args := []any{uid}
	for _, key := range []string{"from", "to"} {
		if raw := r.URL.Query().Get(key); raw != "" {
			day, err := time.Parse("2006-01-02", raw)
			if err != nil {
				app.writeError(w, 422, "Некорректная дата")
				return
			}
			if key == "from" {
				where += " AND julianday(answered_at)>=julianday(?)"
				args = append(args, day.Format(time.RFC3339))
			} else {
				where += " AND julianday(answered_at)<julianday(?)"
				args = append(args, day.AddDate(0, 0, 1).Format(time.RFC3339))
			}
		}
	}
	var library topicLibrary
	data, err := seed.Files.ReadFile("library.json")
	if err != nil || json.Unmarshal(data, &library) != nil {
		app.writeError(w, 500, "Библиотека недоступна")
		return
	}
	labels := map[string]string{}
	for _, node := range library.Nodes {
		labels[node.ID] = node.Label
	}
	rows, err := app.db.Query(statisticsEvents+` SELECT topic_id,test_id,sum(correct),count(*)-sum(correct) FROM events`+where+` GROUP BY topic_id,test_id`, args...)
	if err != nil {
		app.writeError(w, 500, "Не удалось загрузить темы")
		return
	}
	totals := map[string]statisticsTopicRow{}
	for rows.Next() {
		var topicID string
		var testID, correct, wrong int
		if err = rows.Scan(&topicID, &testID, &correct, &wrong); err != nil {
			break
		}
		label := statisticsTopicLabel(labels, topicID, testID)
		row := totals[label]
		row.Topic = label
		row.Correct += correct
		row.Wrong += wrong
		totals[label] = row
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil || rowErr != nil {
		app.writeError(w, 500, "Не удалось прочитать темы")
		return
	}
	result := []statisticsTopicRow{}
	for _, row := range totals {
		if filter == "errors" && row.Wrong == 0 || filter == "perfect" && row.Wrong > 0 {
			continue
		}
		result = append(result, row)
	}
	sort.Slice(result, func(i, j int) bool {
		a, b := result[i].Wrong, result[j].Wrong
		if sortBy == "correct" {
			a, b = result[i].Correct, result[j].Correct
		}
		if a == b {
			return result[i].Topic < result[j].Topic
		}
		if direction == "asc" {
			return a < b
		}
		return a > b
	})
	total := len(result)
	start := min(offset, total)
	end := min(start+30, total)
	days := []string{}
	dates, err := app.db.Query(statisticsEvents+` SELECT DISTINCT date(answered_at) FROM events WHERE user_id=? ORDER BY 1 DESC`, uid)
	if err != nil {
		app.writeError(w, 500, "Не удалось загрузить календарь")
		return
	}
	for dates.Next() {
		var day string
		if err = dates.Scan(&day); err != nil {
			break
		}
		days = append(days, day)
	}
	dateErr := dates.Err()
	dates.Close()
	if err != nil || dateErr != nil {
		app.writeError(w, 500, "Не удалось прочитать календарь")
		return
	}
	app.writeJSON(w, 200, map[string]any{"rows": result[start:end], "total": total, "has_more": end < total, "days": days})
}

func statisticsTopicLabel(labels map[string]string, topicID string, testID int) string {
	if label := labels[topicID]; label != "" {
		return label
	}
	if testID != 0 {
		kind := "Тематический билет"
		if testID >= 100000 {
			kind = "Экзамен"
			testID -= 100000
		}
		return fmt.Sprintf("%s %d", kind, testID)
	}
	return "Тема из предыдущей структуры"
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
