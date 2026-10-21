package app

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/domyshev-labs/road-rules-trainer/backend/seed"
)

type topicReference struct {
	CanonicalID   string   `json:"canonical_id"`
	TestID        int      `json:"test_id"`
	SourceTestID  int      `json:"source_test_id"`
	SourceOrdinal int      `json:"source_ordinal"`
	Index         int      `json:"index"`
	Verified      bool     `json:"verified"`
	TopicIDs      []string `json:"topic_ids"`
}
type topicLibrary struct {
	Nodes []struct {
		ID     string  `json:"id"`
		Label  string  `json:"label_ru"`
		Parent *string `json:"parent_id"`
	} `json:"nodes"`
	Questions []topicReference `json:"questions"`
}
type topicAnswer struct {
	Letter  string `json:"letter"`
	Text    string `json:"text"`
	Correct bool   `json:"-"`
}
type topicProgress struct {
	SelectedLetter string `json:"selected_letter"`
	CorrectLetter  string `json:"correct_letter"`
	Correct        bool   `json:"correct"`
}
type topicQuestion struct {
	ID       string            `json:"id"`
	Number   int               `json:"number"`
	Question string            `json:"question"`
	Image    string            `json:"image_url"`
	Help     map[string]string `json:"help"`
	Answers  []topicAnswer     `json:"answers"`
	Sources  []topicReference  `json:"sources"`
	Progress *topicProgress    `json:"progress,omitempty"`
}

func topicMembers(id string) (string, []topicReference, []topicReference, error) {
	data, err := seed.Files.ReadFile("library.json")
	if err != nil {
		return "", nil, nil, err
	}
	var library topicLibrary
	if err := json.Unmarshal(data, &library); err != nil {
		return "", nil, nil, err
	}
	title := ""
	for _, node := range library.Nodes {
		if node.ID == id {
			title = node.Label
		}
		if node.Parent != nil && *node.Parent == id {
			return "", nil, nil, fmt.Errorf("topic must be a leaf")
		}
	}
	if title == "" {
		return "", nil, nil, fmt.Errorf("unknown topic")
	}
	seen := map[string]bool{}
	members := []topicReference{}
	for _, q := range library.Questions {
		if !q.Verified || seen[q.CanonicalID] {
			continue
		}
		for _, tag := range q.TopicIDs {
			if tag == id {
				members = append(members, q)
				seen[q.CanonicalID] = true
				break
			}
		}
	}
	// IDs provide a deterministic order independent of source-ticket grouping.
	sort.Slice(members, func(i, j int) bool { return members[i].CanonicalID < members[j].CanonicalID })
	return title, members, library.Questions, nil
}

func (app *App) loadTopicQuestion(ref topicReference) (topicQuestion, error) {
	q := topicQuestion{ID: ref.CanonicalID, Help: map[string]string{}, Answers: []topicAnswer{}, Sources: []topicReference{}}
	var en, es, ru string
	var membershipID int
	err := app.db.QueryRow(`SELECT q.id,c.prompt,c.help_en,c.help_es,c.help_ru,q.image_path FROM questions q JOIN question_memberships m ON m.question_id=q.id JOIN question_contents c ON c.id=m.content_id WHERE q.test_id=? AND q.ordinal=? AND c.id=?`, ref.TestID, ref.Index+1, ref.CanonicalID).Scan(&membershipID, &q.Question, &en, &es, &ru, &q.Image)
	if err != nil {
		return q, err
	}
	q.Help = map[string]string{"en": en, "es": es, "ru": ru}
	rows, err := app.db.Query(`SELECT text,correct FROM answers WHERE question_id=?`, membershipID)
	if err != nil {
		return q, err
	}
	defer rows.Close()
	for rows.Next() {
		var a topicAnswer
		if err := rows.Scan(&a.Text, &a.Correct); err != nil {
			return q, err
		}
		q.Answers = append(q.Answers, a)
	}
	if err := rows.Err(); err != nil {
		return q, err
	}
	// Source letters may be shuffled. Topic choices use a stable text-based order.
	sort.Slice(q.Answers, func(i, j int) bool {
		return normalizeTopicText(q.Answers[i].Text) < normalizeTopicText(q.Answers[j].Text)
	})
	for i := range q.Answers {
		q.Answers[i].Letter = string(rune('A' + i))
	}
	return q, nil
}
func normalizeTopicText(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}
func makeTopicProgress(q topicQuestion, selectedText string, correct bool) *topicProgress {
	p := &topicProgress{Correct: correct}
	for _, a := range q.Answers {
		if a.Correct {
			p.CorrectLetter = a.Letter
		}
		if normalizeTopicText(a.Text) == normalizeTopicText(selectedText) {
			p.SelectedLetter = a.Letter
		}
	}
	return p
}
func (app *App) topic(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("topicID")
	title, members, all, err := topicMembers(id)
	if err != nil {
		app.writeError(w, http.StatusNotFound, "Подтема не найдена")
		return
	}
	current := r.Context().Value(userContextKey).(user)
	questions := make([]topicQuestion, 0, len(members))
	for i, ref := range members {
		q, err := app.loadTopicQuestion(ref)
		if err != nil {
			app.serverError(w, err)
			return
		}
		q.Number = i + 1
		for _, source := range all {
			if source.Verified && source.CanonicalID == q.ID {
				q.Sources = append(q.Sources, source)
			}
		}
		var selected string
		var correct bool
		err = app.db.QueryRow(`SELECT selected_text,correct FROM topic_answers WHERE user_id=? AND topic_id=? AND content_id=?`, current.ID, id, q.ID).Scan(&selected, &correct)
		if err == nil {
			q.Progress = makeTopicProgress(q, selected, correct)
		} else if err != sql.ErrNoRows {
			app.serverError(w, err)
			return
		}
		questions = append(questions, q)
	}
	app.writeJSON(w, http.StatusOK, map[string]any{"id": id, "title": title, "questions": questions})
}
func (app *App) answerTopic(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("topicID")
	var input struct {
		QuestionID     string `json:"question_id"`
		SelectedLetter string `json:"selected_letter"`
	}
	if !app.decodeJSON(w, r, &input) {
		return
	}
	_, members, _, err := topicMembers(id)
	if err != nil {
		app.writeError(w, http.StatusNotFound, "Подтема не найдена")
		return
	}
	var ref *topicReference
	for i := range members {
		if members[i].CanonicalID == input.QuestionID {
			ref = &members[i]
			break
		}
	}
	if ref == nil {
		app.writeError(w, http.StatusUnprocessableEntity, "Вопрос не входит в подтему")
		return
	}
	q, err := app.loadTopicQuestion(*ref)
	if err != nil {
		app.serverError(w, err)
		return
	}
	var choice *topicAnswer
	for i := range q.Answers {
		if q.Answers[i].Letter == input.SelectedLetter {
			choice = &q.Answers[i]
			break
		}
	}
	if choice == nil {
		app.writeError(w, http.StatusUnprocessableEntity, "Некорректный вариант ответа")
		return
	}
	current := r.Context().Value(userContextKey).(user)
	_, err = app.db.Exec(`INSERT INTO topic_answers(user_id,topic_id,content_id,selected_text,correct,answered_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,topic_id,content_id) DO NOTHING`, current.ID, id, q.ID, choice.Text, choice.Correct, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		app.serverError(w, err)
		return
	}
	var selected string
	var correct bool
	if err = app.db.QueryRow(`SELECT selected_text,correct FROM topic_answers WHERE user_id=? AND topic_id=? AND content_id=?`, current.ID, id, q.ID).Scan(&selected, &correct); err != nil {
		app.serverError(w, err)
		return
	}
	app.writeJSON(w, http.StatusOK, makeTopicProgress(q, selected, correct))
}
func (app *App) resetTopic(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("topicID")
	if _, _, _, err := topicMembers(id); err != nil {
		app.writeError(w, http.StatusNotFound, "Подтема не найдена")
		return
	}
	current := r.Context().Value(userContextKey).(user)
	if _, err := app.db.Exec(`DELETE FROM topic_answers WHERE user_id=? AND topic_id=?`, current.ID, id); err != nil {
		app.serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// topicSummaries counts only current verified memberships and the signed-in user's answers.
func (app *App) topicSummaries(w http.ResponseWriter, r *http.Request) {
	data, err := seed.Files.ReadFile("library.json")
	if err != nil {
		app.serverError(w, err)
		return
	}
	var library topicLibrary
	if err = json.Unmarshal(data, &library); err != nil {
		app.serverError(w, err)
		return
	}
	parents := map[string]bool{}
	for _, node := range library.Nodes {
		if node.Parent != nil {
			parents[*node.Parent] = true
		}
	}
	members := map[string]map[string]bool{}
	for _, node := range library.Nodes {
		if !parents[node.ID] {
			members[node.ID] = map[string]bool{}
		}
	}
	for _, q := range library.Questions {
		if !q.Verified {
			continue
		}
		for _, tag := range q.TopicIDs {
			if set, ok := members[tag]; ok {
				set[q.CanonicalID] = true
			}
		}
	}
	type summary struct {
		Total        int             `json:"total"`
		Answered     int             `json:"answered"`
		Correct      int             `json:"correct"`
		Wrong        int             `json:"wrong"`
		NextQuestion int             `json:"next_question"`
		Results      map[string]bool `json:"results"`
	}
	result := map[string]*summary{}
	for id, set := range members {
		result[id] = &summary{Total: len(set), Results: map[string]bool{}}
	}
	current := r.Context().Value(userContextKey).(user)
	rows, err := app.db.Query(`SELECT topic_id,content_id,correct FROM topic_answers WHERE user_id=?`, current.ID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id, content string
		var correct bool
		if err = rows.Scan(&id, &content, &correct); err != nil {
			app.serverError(w, err)
			return
		}
		if item, ok := result[id]; ok && members[id][content] {
			item.Results[content] = correct
			item.Answered++
			if correct {
				item.Correct++
			} else {
				item.Wrong++
			}
		}
	}
	if err = rows.Err(); err != nil {
		app.serverError(w, err)
		return
	}
	for id, item := range result {
		ids := make([]string, 0, len(members[id]))
		for content := range members[id] {
			ids = append(ids, content)
		}
		sort.Strings(ids)
		for i, content := range ids {
			if _, answered := item.Results[content]; !answered {
				item.NextQuestion = i + 1
				break
			}
		}
	}
	app.writeJSON(w, http.StatusOK, result)
}
