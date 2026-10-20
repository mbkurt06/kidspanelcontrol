// İlk kurulumda önerilen görev şablonları (hepsi düzenlenebilir/silinebilir).
export const STARTER_TEMPLATES = [
  { title: "Odanı topla", description: "Yatağını yap, yerdeki eşyaları kaldır.", proof: "photo", before_after: true, reward_minutes: 15, reward_validity: "today", mandatory: false },
  { title: "Masanı topla", description: "Masanın üstü ve altı düzenli olsun.", proof: "photo_or_video", before_after: true, reward_minutes: 10, reward_validity: "today", mandatory: false },
  { title: "Ödevini yap", description: "Bitmiş ödevin fotoğrafını çek.", proof: "photo", before_after: false, reward_minutes: null, reward_validity: "today", mandatory: true },
  { title: "Tekrarları yap", description: "Bugünkü derslerin tekrarı.", proof: "video", before_after: false, reward_minutes: 20, reward_validity: "today", mandatory: false },
  { title: "Kitap oku (20 dk)", description: "Okuduğun sayfanın fotoğrafını çek.", proof: "photo", before_after: false, reward_minutes: 15, reward_validity: "today", mandatory: false },
  { title: "Bulaşık makinesini boşalt", description: null, proof: "photo", before_after: false, reward_minutes: 10, reward_validity: "wallet", mandatory: false },
] as const;
