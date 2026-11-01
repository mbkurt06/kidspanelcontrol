export function todayISO(tz = "Europe/Berlin", offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function minutesText(m: number | null | undefined) {
  if (m == null) return "—";
  const sign = m < 0 ? "-" : "";
  const a = Math.abs(Math.round(m));
  const h = Math.floor(a / 60);
  const mm = a % 60;
  if (h === 0) return `${sign}${mm} dk`;
  if (mm === 0) return `${sign}${h} sa`;
  return `${sign}${h} sa ${mm} dk`;
}

export function relTime(iso: string | null | undefined) {
  if (!iso) return "hiç";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "az önce";
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return `${Math.floor(s / 86400)} gün önce`;
}

export function hhmm(t: string) {
  return t.slice(0, 5);
}

export function daysText(days: number[]) {
  const names = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
  const s = [...days].sort();
  if (s.length === 7) return "Her gün";
  if (s.join() === "1,2,3,4,5") return "Hafta içi";
  if (s.join() === "6,7") return "Hafta sonu";
  return s.map((d) => names[d - 1]).join(", ");
}

export function dateText(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("tr-TR", { day: "numeric", month: "long", weekday: "short" });
}

export function dateTimeText(iso: string) {
  return new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" }) + " · " + new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}

export function agendaDateText(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", weekday: "long" });
}
