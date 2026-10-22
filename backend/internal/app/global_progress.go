package app

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/domyshev-labs/road-rules-trainer/backend/seed"
)

// Original answer events remain immutable. Reviews never replace normal-training knowledge.
func migrateGlobalProgress(db *sql.DB) error {
	_, err := db.Exec(`
 CREATE TABLE IF NOT EXISTS topic_run_inherited (
 run_id INTEGER NOT NULL REFERENCES topic_runs(id) ON DELETE CASCADE,
 content_id TEXT NOT NULL REFERENCES question_contents(id),
 selected_text TEXT NOT NULL, correct INTEGER NOT NULL, answered_at TEXT NOT NULL,
 PRIMARY KEY(run_id,content_id));
 CREATE TABLE IF NOT EXISTS topic_reorganized_runs (run_id INTEGER PRIMARY KEY REFERENCES topic_runs(id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS taxonomy_memberships (
 topic_id TEXT NOT NULL, content_id TEXT NOT NULL, present INTEGER NOT NULL,
 added_at TEXT NOT NULL, initial_member INTEGER NOT NULL, PRIMARY KEY(topic_id,content_id));
 CREATE VIEW IF NOT EXISTS question_progress AS
 SELECT user_id,content_id,selected_text,correct,answered_at FROM (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY user_id,content_id ORDER BY julianday(answered_at) DESC,answered_at DESC,event_id DESC) AS position FROM (
 SELECT user_id,content_id,selected_text,correct,answered_at,'legacy:'||topic_id AS event_id FROM topic_answers
 UNION ALL
 SELECT r.user_id,a.content_id,a.selected_text,a.correct,a.answered_at,'topic:'||printf('%020d',r.id) FROM topic_run_answers a JOIN topic_runs r ON r.id=a.run_id WHERE r.parent_id IS NULL
 UNION ALL
 SELECT t.user_id,m.content_id,COALESCE(choice.text,''),a.correct,a.answered_at,'ticket:'||t.id FROM attempt_answers a JOIN attempts t ON t.id=a.attempt_id JOIN question_memberships m ON m.question_id=a.question_id LEFT JOIN answers choice ON choice.question_id=a.question_id AND choice.letter=a.selected_letter WHERE t.mode='full'
 )) WHERE position=1;
 CREATE VIEW IF NOT EXISTS topic_run_progress AS
 SELECT run_id,content_id,selected_text,correct,answered_at,0 AS inherited FROM topic_run_answers
 UNION ALL
 SELECT i.run_id,i.content_id,i.selected_text,i.correct,i.answered_at,1 FROM topic_run_inherited i WHERE NOT EXISTS(SELECT 1 FROM topic_run_answers a WHERE a.run_id=i.run_id AND a.content_id=i.content_id);
 `)
	return err
}

func reconcileTopicMemberships(db *sql.DB) error {
	currentBytes, err := seed.Files.ReadFile("library.json")
	if err != nil {
		return err
	}
	var current topicLibrary
	if err = json.Unmarshal(currentBytes, &current); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM taxonomy_memberships`).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		oldBytes, e := seed.Files.ReadFile("library-before-reorganization.json")
		if e != nil {
			return e
		}
		var old topicLibrary
		if e = json.Unmarshal(oldBytes, &old); e != nil {
			return e
		}
		for _, q := range old.Questions {
			if !q.Verified {
				continue
			}
			for _, id := range q.TopicIDs {
				if _, err = tx.Exec(`INSERT OR IGNORE INTO taxonomy_memberships VALUES(?,?,1,'1970-01-01T00:00:00Z',1)`, id, q.CanonicalID); err != nil {
					return err
				}
			}
		}
	}
	rows, err := tx.Query(`SELECT topic_id,content_id FROM taxonomy_memberships WHERE present=1`)
	if err != nil {
		return err
	}
	previous := map[string]bool{}
	for rows.Next() {
		var topic, content string
		if err = rows.Scan(&topic, &content); err != nil {
			rows.Close()
			return err
		}
		previous[topic+":"+content] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE taxonomy_memberships SET present=0`); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, q := range current.Questions {
		if !q.Verified {
			continue
		}
		for _, id := range q.TopicIDs {
			if previous[id+":"+q.CanonicalID] {
				_, err = tx.Exec(`UPDATE taxonomy_memberships SET present=1 WHERE topic_id=? AND content_id=?`, id, q.CanonicalID)
			} else {
				_, err = tx.Exec(`INSERT INTO taxonomy_memberships VALUES(?,?,1,?,0) ON CONFLICT(topic_id,content_id) DO UPDATE SET present=1,added_at=excluded.added_at,initial_member=0`, id, q.CanonicalID, now)
			}
			if err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

type knownAnswer struct {
	Text    string
	Correct bool
	At      string
}

func (app *App) globalAnswers(userID string) (map[string]knownAnswer, error) {
	rows, err := app.db.Query(`SELECT content_id,selected_text,correct,answered_at FROM question_progress WHERE user_id=?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]knownAnswer{}
	for rows.Next() {
		var id string
		var a knownAnswer
		if err = rows.Scan(&id, &a.Text, &a.Correct, &a.At); err != nil {
			return nil, err
		}
		result[id] = a
	}
	return result, rows.Err()
}

// Carry earlier answers into the first topic run as explicitly inherited snapshots.
// Fresh full repeats and completed historical runs keep their own answers unchanged.
func inheritTopicProgress(tx *sql.Tx, id int64) error {
	_, err := tx.Exec(`INSERT OR IGNORE INTO topic_run_inherited
 SELECT r.id,p.content_id,p.selected_text,p.correct,p.answered_at FROM topic_runs r
 JOIN topic_run_members m ON m.run_id=r.id JOIN question_progress p ON p.user_id=r.user_id AND p.content_id=m.content_id
 WHERE r.id=? AND r.parent_id IS NULL AND r.completed_at IS NULL
 AND r.id >= (SELECT MAX(f.id) FROM topic_runs f WHERE f.user_id=r.user_id AND f.topic_id=r.topic_id AND f.parent_id IS NULL AND f.kind='full')
 AND (r.kind='new' OR EXISTS(SELECT 1 FROM topic_reorganized_runs c WHERE c.run_id=r.id) OR r.id=(SELECT MIN(f.id) FROM topic_runs f WHERE f.user_id=r.user_id AND f.topic_id=r.topic_id AND f.parent_id IS NULL AND f.kind='full'))
 AND NOT EXISTS(SELECT 1 FROM topic_run_answers a WHERE a.run_id=r.id AND a.content_id=m.content_id)`, id)
	if err != nil {
		return err
	}
	return completeTopicRun(tx, id)
}

// Frozen runs can still show questions moved out of the current topic.
func historicalTopicMembers(ids map[string]bool, current []topicReference) ([]topicReference, error) {
	data, err := seed.Files.ReadFile("library.json")
	if err != nil {
		return nil, err
	}
	var library topicLibrary
	if err = json.Unmarshal(data, &library); err != nil {
		return nil, err
	}
	found := map[string]topicReference{}
	for _, ref := range append(current, library.Questions...) {
		if ref.Verified && ids[ref.CanonicalID] {
			if _, ok := found[ref.CanonicalID]; !ok {
				found[ref.CanonicalID] = ref
			}
		}
	}
	result := []topicReference{}
	for _, ref := range found {
		result = append(result, ref)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CanonicalID < result[j].CanonicalID })
	return result, nil
}

func (app *App) reorganizedQuestions(userID, topicID string) (map[string]bool, error) {
	rows, err := app.db.Query(`SELECT m.content_id FROM taxonomy_memberships m JOIN users u ON u.id=? WHERE m.topic_id=? AND m.present=1 AND m.initial_member=0 AND julianday(u.created_at)<julianday(m.added_at)`, userID, topicID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		result[id] = true
	}
	return result, rows.Err()
}

// Only previously answered questions expose their feedback, scoped to the signed-in user.
func (app *App) questionKnowledge(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userContextKey).(user).ID
	rows, err := app.db.Query(`SELECT p.content_id,p.selected_text,p.correct,p.answered_at,COALESCE((SELECT a.text FROM answers a JOIN question_memberships m ON m.question_id=a.question_id WHERE m.content_id=p.content_id AND a.correct=1 LIMIT 1),'') FROM question_progress p WHERE p.user_id=?`, userID)
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer rows.Close()
	type item struct {
		Selected    string `json:"selected_text"`
		Correct     bool   `json:"correct"`
		At          string `json:"answered_at"`
		CorrectText string `json:"correct_text"`
	}
	result := map[string]item{}
	for rows.Next() {
		var id string
		var value item
		if err = rows.Scan(&id, &value.Selected, &value.Correct, &value.At, &value.CorrectText); err != nil {
			app.serverError(w, err)
			return
		}
		result[id] = value
	}
	if err = rows.Err(); err != nil {
		app.serverError(w, err)
		return
	}
	app.writeJSON(w, 200, result)
}

// A removed membership requires a fresh current view, while old runs stay frozen.
func refreshReorganizedRun(tx *sql.Tx, userID, topicID string, id int64, members []topicReference) (int64, error) {
	rows, err := tx.Query(`SELECT content_id FROM topic_run_members WHERE run_id=?`, id)
	if err != nil {
		return 0, err
	}
	current := map[string]bool{}
	for _, ref := range members {
		current[ref.CanonicalID] = true
	}
	removed := false
	for rows.Next() {
		var content string
		if err = rows.Scan(&content); err != nil {
			rows.Close()
			return 0, err
		}
		if !current[content] {
			removed = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	if !removed {
		return id, nil
	}
	result, err := tx.Exec(`INSERT INTO topic_runs(user_id,topic_id,total,started_at) VALUES(?,?,?,?)`, userID, topicID, len(members), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	next, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if _, err = tx.Exec(`INSERT INTO topic_reorganized_runs VALUES(?)`, next); err != nil {
		return 0, err
	}
	return next, saveRunMembers(tx, next, members)
}
