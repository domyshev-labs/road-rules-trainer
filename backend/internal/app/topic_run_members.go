package app

import (
	"database/sql"
	"fmt"
	"net/http"
	"time"
)

func migrateTopicRunKinds(db *sql.DB) error {
	rows, err := db.Query(`PRAGMA table_info(topic_runs)`)
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var value sql.NullString
		if err = rows.Scan(&cid, &name, &typ, &notNull, &value, &pk); err != nil {
			rows.Close()
			return err
		}
		found = found || name == "kind"
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !found {
		_, err = db.Exec(`ALTER TABLE topic_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'full' CHECK(kind IN ('full','new'))`)
	}
	return err
}
func saveRunMembers(tx *sql.Tx, id int64, members []topicReference) error {
	for _, ref := range members {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO topic_run_members VALUES(?,?)`, id, ref.CanonicalID); err != nil {
			return err
		}
	}
	return nil
}

// Completed legacy runs know their exact membership from their answer records.
func snapshotLegacyMembers(tx *sql.Tx, id int64, members []topicReference) error {
	var count, total int
	var completed sql.NullString
	if err := tx.QueryRow(`SELECT total,completed_at,(SELECT COUNT(*) FROM topic_run_members WHERE run_id=r.id) FROM topic_runs r WHERE id=?`, id).Scan(&total, &completed, &count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	if completed.Valid {
		_, err := tx.Exec(`INSERT OR IGNORE INTO topic_run_members SELECT run_id,content_id FROM topic_run_answers WHERE run_id=?`, id)
		return err
	}
	// Incomplete legacy runs did not store unanswered membership; current membership is the only available baseline.
	if total != len(members) {
		if _, err := tx.Exec(`UPDATE topic_runs SET total=? WHERE id=?`, len(members), id); err != nil {
			return err
		}
	}
	return saveRunMembers(tx, id, members)
}
func (app *App) runMembers(userID, topicID string, id int64, members []topicReference) ([]topicReference, string, error) {
	rows, err := app.db.Query(`SELECT m.content_id,r.kind FROM topic_runs r JOIN topic_run_members m ON m.run_id=r.id WHERE r.id=? AND r.user_id=? AND r.topic_id=? AND r.parent_id IS NULL`, id, userID, topicID)
	if err != nil {
		return nil, "", err
	}
	ids := map[string]bool{}
	kind := ""
	for rows.Next() {
		var content string
		if err = rows.Scan(&content, &kind); err != nil {
			rows.Close()
			return nil, "", err
		}
		ids[content] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, "", err
	}
	if len(ids) == 0 {
		return nil, "", fmt.Errorf("run not found")
	}
	filtered, err := historicalTopicMembers(ids, members)
	return filtered, kind, err
}
func (app *App) newTopicQuestions(userID, topicID string, members []topicReference) ([]string, map[string]int64, error) {
	known, err := app.globalAnswers(userID)
	if err != nil {
		return nil, nil, err
	}
	added, err := app.reorganizedQuestions(userID, topicID)
	if err != nil {
		return nil, nil, err
	}
	var fullID int64
	err = app.db.QueryRow(`SELECT id FROM topic_runs WHERE user_id=? AND topic_id=? AND kind='full' AND parent_id IS NULL ORDER BY id DESC LIMIT 1`, userID, topicID).Scan(&fullID)
	if err != nil && err != sql.ErrNoRows {
		return nil, nil, err
	}
	rows, err := app.db.Query(`SELECT m.content_id,r.id,EXISTS(SELECT 1 FROM topic_answers a WHERE a.user_id=r.user_id AND a.topic_id=r.topic_id AND a.content_id=m.content_id) FROM topic_runs r JOIN topic_run_members m ON m.run_id=r.id WHERE r.user_id=? AND r.topic_id=? AND r.parent_id IS NULL AND r.id>=? ORDER BY r.id`, userID, topicID, fullID)
	if err != nil {
		return nil, nil, err
	}
	baseline := map[string]bool{}
	answered := map[string]bool{}
	runs := map[string]int64{}
	for rows.Next() {
		var content string
		var id int64
		var done bool
		if err = rows.Scan(&content, &id, &done); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if id == fullID {
			baseline[content] = true
		}
		runs[content] = id
		answered[content] = done
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	pending := []string{}
	for _, ref := range members {
		if _, done := known[ref.CanonicalID]; !done && ((fullID > 0 && !baseline[ref.CanonicalID]) || added[ref.CanonicalID]) && !answered[ref.CanonicalID] {
			pending = append(pending, ref.CanonicalID)
			answered[ref.CanonicalID] = true
		}
	}
	return pending, runs, nil
}
func (app *App) startNewTopicQuestions(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(userContextKey).(user).ID
	topicID := r.PathValue("topicID")
	_, members, _, err := topicMembers(topicID)
	if err != nil {
		app.writeError(w, 404, "Подтема не найдена")
		return
	}
	if _, err = app.currentTopicRun(userID, topicID, members); err != nil {
		app.serverError(w, err)
		return
	}
	candidateIDs, _, err := app.newTopicQuestions(userID, topicID, members)
	if err != nil {
		app.serverError(w, err)
		return
	}
	tx, err := app.db.Begin()
	if err != nil {
		app.serverError(w, err)
		return
	}
	defer tx.Rollback()
	// Resume the frozen active batch; additions arriving during it form a later batch.
	var id int64
	err = tx.QueryRow(`SELECT id FROM topic_runs WHERE user_id=? AND topic_id=? AND kind='new' AND parent_id IS NULL AND completed_at IS NULL AND id>(SELECT MAX(id) FROM topic_runs WHERE user_id=? AND topic_id=? AND kind='full' AND parent_id IS NULL) ORDER BY id LIMIT 1`, userID, topicID, userID, topicID).Scan(&id)
	if err == sql.ErrNoRows {
		// Use the same global-knowledge and reorganization semantics as the overview.
		// Gather candidates before entering this transaction (the database has one connection).
		pending := []string{}
		for _, content := range candidateIDs {
			var done bool
			if err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM question_progress WHERE user_id=? AND content_id=?)`, userID, content).Scan(&done); err != nil {
				app.serverError(w, err)
				return
			}
			if !done {
				pending = append(pending, content)
			}
		}
		if len(pending) == 0 {
			app.writeError(w, 409, "Новых вопросов нет")
			return
		}
		result, e := tx.Exec(`INSERT INTO topic_runs(user_id,topic_id,kind,total,started_at) VALUES(?,?,'new',?,?)`, userID, topicID, len(pending), time.Now().UTC().Format(time.RFC3339Nano))
		if e != nil {
			app.serverError(w, e)
			return
		}
		id, err = result.LastInsertId()
		if err == nil {
			for _, content := range pending {
				if _, err = tx.Exec(`INSERT INTO topic_run_members VALUES(?,?)`, id, content); err != nil {
					break
				}
			}
		}
	}
	if err != nil {
		app.serverError(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		app.serverError(w, err)
		return
	}
	app.writeJSON(w, 200, map[string]int64{"id": id})
}
