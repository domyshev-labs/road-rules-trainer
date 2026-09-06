package app

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/resend/resend-go/v3"
)

type EmailSender interface {
	SendLoginCode(context.Context, string, string) error
}

type logEmailSender struct{ logger *slog.Logger }

func (sender logEmailSender) SendLoginCode(_ context.Context, email, code string) error {
	sender.logger.Warn("development login code", "email", email, "code", code)
	return nil
}

type resendEmailSender struct {
	client *resend.Client
	from   string
}

func (sender resendEmailSender) SendLoginCode(_ context.Context, email, code string) error {
	_, err := sender.client.Emails.Send(&resend.SendEmailRequest{
		From:    sender.from,
		To:      []string{email},
		Subject: "Код входа в Road Rules Trainer",
		Text:    fmt.Sprintf("Ваш код входа: %s\n\nОн действует 10 минут. Если вы не запрашивали код, просто проигнорируйте это письмо.", code),
		Html:    fmt.Sprintf(`<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto"><h1 style="color:#0d6b4d">Road Rules Trainer</h1><p>Ваш код входа:</p><p style="font-size:32px;font-weight:800;letter-spacing:8px">%s</p><p>Код действует 10 минут. Если вы его не запрашивали, просто проигнорируйте письмо.</p></div>`, code),
	})
	return err
}
