-- Görevler gece 00:00'da kapanır: telefon kapalı olsa da süresi geçenler 5 dk'da bir kapatılır, ödül / ceza hemen yazılır
select cron.schedule('orbit-expire-runs', '*/5 * * * *', $$select orbit.expire_runs((now() at time zone 'Europe/Berlin')::date)$$);
