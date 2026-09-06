package app

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/domyshev-labs/road-rules-trainer/backend/seed"
	_ "modernc.org/sqlite"
)

const schema = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  request_ip TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email_created ON login_codes(email, created_at DESC);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  question_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  number TEXT NOT NULL,
  prompt TEXT NOT NULL,
  help_en TEXT NOT NULL,
  help_es TEXT NOT NULL,
  help_ru TEXT NOT NULL,
  image_path TEXT NOT NULL,
  UNIQUE(test_id, ordinal)
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  letter TEXT NOT NULL,
  text TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK(correct IN (0,1)),
  UNIQUE(question_id, letter)
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_id INTEGER NOT NULL REFERENCES tests(id),
  mode TEXT NOT NULL CHECK(mode IN ('full','mistakes')),
  total INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_user_test ON attempts(user_id, test_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_user_source ON attempts(user_id, source_id) WHERE source_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS attempt_answers (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  selected_letter TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK(correct IN (0,1)),
  answered_at TEXT NOT NULL,
  PRIMARY KEY(attempt_id, question_id)
);
`

type seedAnswer struct {
	Letter  string `json:"letter"`
	Text    string `json:"text"`
	Correct bool   `json:"correct"`
}

type seedQuestion struct {
	Number     string       `json:"number"`
	Question   string       `json:"question"`
	Help       string       `json:"help"`
	LocalImage string       `json:"local_image"`
	Answers    []seedAnswer `json:"answers"`
}

type seedTest struct {
	TestID    int            `json:"test_id"`
	Title     string         `json:"title"`
	Questions []seedQuestion `json:"questions"`
}

type seedHelp struct {
	Help map[string]map[string]string `json:"help"`
}

func openDatabase(path string) (*sql.DB, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	if err := seedDatabase(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("seed database: %w", err)
	}
	return db, nil
}

func seedDatabase(db *sql.DB) error {
	entries, err := fs.Glob(seed.Files, "test-*.json")
	if err != nil {
		return err
	}
	sort.Strings(entries)
	helps := make(map[int]seedHelp)
	for _, name := range entries {
		if !strings.HasSuffix(name, "-help.json") {
			continue
		}
		data, readErr := seed.Files.ReadFile(name)
		if readErr != nil {
			return readErr
		}
		var file struct {
			TestID int `json:"test_id"`
			seedHelp
		}
		if err := json.Unmarshal(data, &file); err != nil {
			return fmt.Errorf("decode %s: %w", name, err)
		}
		helps[file.TestID] = file.seedHelp
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, name := range entries {
		if strings.HasSuffix(name, "-help.json") {
			continue
		}
		data, readErr := seed.Files.ReadFile(name)
		if readErr != nil {
			return readErr
		}
		var test seedTest
		if err := json.Unmarshal(data, &test); err != nil {
			return fmt.Errorf("decode %s: %w", name, err)
		}
		if _, err := tx.Exec(`INSERT INTO tests(id,title,question_count) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,question_count=excluded.question_count`, test.TestID, test.Title, len(test.Questions)); err != nil {
			return err
		}
		for index, question := range test.Questions {
			translations := helps[test.TestID].Help[fmt.Sprint(index+1)]
			helpEN := translations["en"]
			if helpEN == "" {
				helpEN = question.Help
			}
			imagePath := fmt.Sprintf("/tests/%d/q%02d.jpg", test.TestID, index+1)
			_, err := tx.Exec(`INSERT INTO questions(test_id,ordinal,number,prompt,help_en,help_es,help_ru,image_path) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(test_id,ordinal) DO UPDATE SET number=excluded.number,prompt=excluded.prompt,help_en=excluded.help_en,help_es=excluded.help_es,help_ru=excluded.help_ru,image_path=excluded.image_path`, test.TestID, index+1, question.Number, question.Question, helpEN, translations["es"], translations["ru"], imagePath)
			if err != nil {
				return err
			}
			var questionID int64
			if err = tx.QueryRow(`SELECT id FROM questions WHERE test_id=? AND ordinal=?`, test.TestID, index+1).Scan(&questionID); err != nil {
				return err
			}
			for _, answer := range question.Answers {
				if _, err := tx.Exec(`INSERT INTO answers(question_id,letter,text,correct) VALUES(?,?,?,?) ON CONFLICT(question_id,letter) DO UPDATE SET text=excluded.text,correct=excluded.correct`, questionID, answer.Letter, answer.Text, answer.Correct); err != nil {
					return err
				}
			}
		}
	}
	return tx.Commit()
}
