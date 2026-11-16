-- Açık saatleri bugünlük uzatma: süre aralığının asıl bitişi (geri almak için)
alter table orbit.time_grants add column if not exists orig_window_end time;
