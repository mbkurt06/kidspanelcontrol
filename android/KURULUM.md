# Orbit — çocuk telefonu kurulumu (bir kerelik)

Orbit telefonda **cihaz sahibi (device owner)** olarak çalışır. Bu yetki sadece fabrika ayarlarına dönmüş,
hesap eklenmemiş bir telefona verilebilir.

## Hazırlık

1. Telefonun fotoğraflarını ve önemli verilerini yedekle.
2. Ayarlar → Mi hesabı → **çıkış yap** (Mi hesabı açıkken sıfırlama sonrası telefon kilitli kalabilir).
3. Google hesabını da kaldır. Family Link gözetimi varsa önce ebeveyn telefonundan kaldır.
4. Ayarlar → Telefon hakkında → **Fabrika ayarlarına sıfırla**.

## Kurulum

1. Açılışta dil ve Wi-Fi'yi seç. **Google ve Mi hesabı ekleme**, "Atla" de.
2. Ayarlar → Telefon hakkında → **MIUI/HyperOS sürümü**ne 7 kez dokun → geliştirici seçenekleri açılır.
3. Ayarlar → Ek ayarlar → Geliştirici seçenekleri → **USB hata ayıklama** ve **USB ile yükle** (Xiaomi) açık.
4. Telefonu Mac'e bağla, telefondaki "USB hata ayıklamaya izin ver" sorusunu onayla.
5. Mac'te (Android Studio'nun adb aracı):

   ```sh
   ADB=~/Library/Android/sdk/platform-tools/adb
   $ADB install orbit-<surum>.apk                                   # GitHub Releases'tan
   $ADB shell dpm set-device-owner app.orbit/.device.AdminReceiver  # cihaz sahibi
   $ADB shell appops set app.orbit GET_USAGE_STATS allow            # süre sayımı
   $ADB shell appops set app.orbit SYSTEM_ALERT_WINDOW allow        # kilit ekranı
   $ADB shell dumpsys deviceidle whitelist +app.orbit               # pil kısıtlaması yok
   $ADB shell am broadcast -a app.orbit.CONFIG -n app.orbit/.service.ConfigReceiver --es token <GITHUB_OKUMA_ANAHTARI>
   ```

6. Telefonda Orbit'i aç → ebeveyn panelinde çocuğun sayfası → **Telefon** → "Eşleştirme kodu al" → kodu gir.
7. Xiaomi ayarları: Ayarlar → Uygulamalar → Orbit → **Otomatik başlatma: açık**, **Pil tasarrufu: kısıtlama yok**.
8. Çocuğun Google hesabını ekle (Play Store için).
9. Ebeveyn panelinde çocuğun **Uygulamalar** sekmesinden uygulamaları gruplara ata.

Orbit ilk çalışmada geliştirici seçeneklerini ve USB hata ayıklamayı kapatır. Sonradan bilgisayardan bakım
gerekirse panelden geçici "bakım modu" açılır.

## Güncelleme anahtarı (GitHub)

github.com → Settings → Developer settings → **Fine-grained tokens** → Generate new token:

- Repository access: *Only select repositories* → `kidspanelcontrol`
- Permissions: **Contents: Read-only**
- Expiration: en uzun süre

Telefon her 6 saatte bir yeni sürüm olup olmadığına bakar ve sessizce kurar.
